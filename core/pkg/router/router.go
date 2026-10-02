package router

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/wfzyx/meepo/pkg/config"
)

type ToolPruningResult struct {
	Allowed             []string `json:"allowed"`
	Pruned              []string `json:"pruned"`
	MCPStripped         []string `json:"mcpStripped"`
	TokensSavedEstimate int      `json:"tokensSavedEstimate"`
}

type RoutingDecision struct {
	TargetRole          string   `json:"targetRole"`
	Confidence          float64  `json:"confidence"`
	AllowedTools        []string `json:"allowedTools"`
	PrunedTools         []string `json:"prunedTools"`
	MCPStripped         []string `json:"mcpStripped"`
	TokensSavedEstimate int      `json:"tokensSavedEstimate"`
	Reason              string   `json:"reason"`
	LatencyMs           int64    `json:"latencyMs"`
	Source              string   `json:"source"`
}

type Router struct {
	cfg        *config.Config
	httpClient *http.Client
}

func NewRouter(cfg *config.Config) *Router {
	return &Router{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 1500 * time.Millisecond,
		},
	}
}

func (r *Router) UpdateConfig(cfg *config.Config) {
	r.cfg = cfg
}

func (r *Router) CalculateToolPruning(targetRole string, availableTools []string) ToolPruningResult {
	if len(availableTools) == 0 {
		return ToolPruningResult{
			Allowed:             nil,
			Pruned:              nil,
			MCPStripped:         nil,
			TokensSavedEstimate: 0,
		}
	}

	roleAllowMap := map[string][]string{
		"chat":  {"read", "web_search", "web_fetch", "ask"},
		"tools": {"codemode", "bash", "read", "write", "edit", "undo_last_edit"},
		"code":  {"codemode", "read", "edit", "write"},
		"cloud": {"codemode", "ask", "read"},
	}
	allowedNames := roleAllowMap[targetRole]
	allowSet := make(map[string]bool)
	for _, a := range allowedNames {
		allowSet[a] = true
	}

	var allowed []string
	var pruned []string
	var mcpStripped []string

	for _, tool := range availableTools {
		isMCP := strings.HasPrefix(tool, "mcp__") || strings.HasPrefix(tool, "mcp_") || tool == "mcp" || tool == "mcpScript"
		if isMCP {
			mcpStripped = append(mcpStripped, tool)
		}

		if allowSet[tool] {
			allowed = append(allowed, tool)
		} else {
			pruned = append(pruned, tool)
		}
	}

	tokensSaved := len(pruned) * 350
	return ToolPruningResult{
		Allowed:             allowed,
		Pruned:              pruned,
		MCPStripped:         mcpStripped,
		TokensSavedEstimate: tokensSaved,
	}
}

func (r *Router) HeuristicClassify(prompt string) string {
	p := strings.ToLower(prompt)

	// Cloud escalation triggers
	for _, trigger := range r.cfg.Policy.CloudEscalationTriggers {
		normalized := strings.ReplaceAll(trigger, "_", " ")
		if strings.Contains(p, normalized) {
			return "cloud"
		}
	}
	if strings.Contains(p, "deadlock") || strings.Contains(p, "race condition") || strings.Contains(p, "architecture decision") || strings.Contains(p, "advisor") {
		return "cloud"
	}

	// Code engine triggers
	codeKeywords := []string{"implement", "refactor", "function", "write code", "fix bug", "patch", "syntax", "unit test", "diff", "codemode", "script"}
	codeExtensions := []string{".ts", ".js", ".go", ".py", ".rs", ".cpp", ".json"}

	for _, kw := range codeKeywords {
		if strings.Contains(p, kw) {
			return "code"
		}
	}
	for _, ext := range codeExtensions {
		if strings.Contains(p, ext) {
			return "code"
		}
	}

	// Operational tools triggers
	opsKeywords := []string{
		"run", "bash", "exec", "terminal", "command", "check disk", "git", "status",
		"ps aux", "ls", "grep", "curl", "fetch", "fastfetch", "neofetch", "sysinfo",
		"hardware", "memory", "throughput", "bandwidth", "specs", "cpu", "ram", "lscpu",
		"free -m", "disk", "find", "cat", "tail", "head",
	}
	for _, kw := range opsKeywords {
		if strings.Contains(p, kw) {
			return "tools"
		}
	}

	return "chat"
}

type vonQuestion struct {
	Type         string            `json:"type"`
	Instructions string            `json:"instructions"`
	Criteria     map[string]string `json:"criteria"`
}

type vonRequest struct {
	State     string                 `json:"state"`
	Questions map[string]vonQuestion `json:"questions"`
}

type vonResponse struct {
	Answers map[string]struct {
		Choice        string             `json:"choice"`
		Probabilities map[string]float64 `json:"probabilities"`
		Confidence    float64            `json:"confidence"`
	} `json:"answers"`
}

func (r *Router) RouteTurn(ctx context.Context, userPrompt string, availableTools []string) RoutingDecision {
	start := time.Now()

	if r.cfg.Roles.Router.Enabled {
		// Short, contrastive criteria. Measured on a 15-probe set against Von
		// 1.3.5: the old verbose criteria sent "hi there" to tools (0.20) and
		// scored 10/12; these score 14/15 with zero false chat at >= 0.80.
		criteria := map[string]string{
			"chat":  "Greetings, small talk, thanks, or explaining a concept (programming or general) from knowledge alone.",
			"tools": "Needs live facts from this machine: run shell commands, inspect hardware, files, processes, or git.",
			"code":  "Write, edit, refactor, or debug source code.",
			"cloud": "Hard architecture problems: distributed systems design, deadlocks, race conditions, protocol redesign.",
		}

		vReq := vonRequest{
			State: userPrompt,
			Questions: map[string]vonQuestion{
				"intent": {
					Type:         "choice",
					Instructions: "Which engine should handle this user message?",
					Criteria:     criteria,
				},
			},
		}

		reqBytes, err := json.Marshal(vReq)
		if err == nil {
			req, err := http.NewRequestWithContext(ctx, "POST", r.cfg.Roles.Router.Endpoint, bytes.NewReader(reqBytes))
			if err == nil {
				req.Header.Set("Content-Type", "application/json")
				resp, err := r.httpClient.Do(req)
				if err == nil && resp.StatusCode == http.StatusOK {
					defer resp.Body.Close()
					var vResp vonResponse
					if err := json.NewDecoder(resp.Body).Decode(&vResp); err == nil {
						ans, ok := vResp.Answers["intent"]
						if ok && ans.Choice != "" {
							targetRole := ans.Choice
							confidence := ans.Confidence
							if c, exists := ans.Probabilities[targetRole]; confidence <= 0 && exists {
								confidence = c
							}

							// Guardrail: Never escalate to cloud on low confidence (< 0.70)
							if targetRole == "cloud" && confidence < 0.70 {
								targetRole = "chat"
							}

							pruning := r.CalculateToolPruning(targetRole, availableTools)
							return RoutingDecision{
								TargetRole:          targetRole,
								Confidence:          confidence,
								AllowedTools:        pruning.Allowed,
								PrunedTools:         pruning.Pruned,
								MCPStripped:         pruning.MCPStripped,
								TokensSavedEstimate: pruning.TokensSavedEstimate,
								Reason:              "Von 1.3.5 single-pass intent routing",
								LatencyMs:           time.Since(start).Milliseconds(),
								Source:              "von",
							}
						}
					}
				}
			}
		}
	}

	// Heuristic fallback
	heuristicRole := r.HeuristicClassify(userPrompt)
	pruning := r.CalculateToolPruning(heuristicRole, availableTools)
	return RoutingDecision{
		TargetRole:          heuristicRole,
		Confidence:          0.70,
		AllowedTools:        pruning.Allowed,
		PrunedTools:         pruning.Pruned,
		MCPStripped:         pruning.MCPStripped,
		TokensSavedEstimate: pruning.TokensSavedEstimate,
		Reason:              "Rule-based heuristic pattern match (Von offline)",
		LatencyMs:           time.Since(start).Milliseconds(),
		Source:              "heuristic",
	}
}
