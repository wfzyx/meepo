package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/wfzyx/meepo/pkg/config"
	"github.com/wfzyx/meepo/pkg/router"
)

type Server struct {
	cfg        *config.Config
	router     *router.Router
	httpClient *http.Client
	httpServer *http.Server
}

func NewServer(cfg *config.Config) *Server {
	return &Server{
		cfg:    cfg,
		router: router.NewRouter(cfg),
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

func (s *Server) Start(addr string) error {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/v1/health", s.handleHealth)
	mux.HandleFunc("/v1/models", s.handleModels)
	mux.HandleFunc("/models", s.handleModels)
	mux.HandleFunc("/props", s.handleProps)
	mux.HandleFunc("/models/sse", s.handleModelsSSE)
	mux.HandleFunc("/models/load", s.handleModelsLoad)
	mux.HandleFunc("/models/unload", s.handleModelsUnload)
	mux.HandleFunc("/v1/chat/completions", s.handleChatCompletions)
	mux.HandleFunc("/v1/shutdown", s.handleShutdown)
	mux.HandleFunc("/v1/warmup", s.handleWarmup)

	s.httpServer = &http.Server{
		Addr:    addr,
		Handler: corsMiddleware(mux),
	}

	if s.cfg.Policy.WarmupPrefill {
		go s.WarmupFrontman()
	}
	return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	if s.httpServer != nil {
		return s.httpServer.Shutdown(ctx)
	}
	return nil
}

func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status":  "shutting_down",
		"message": "Meepo proxy shutting down gracefully",
	})

	go func() {
		time.Sleep(100 * time.Millisecond)
		_ = s.Shutdown(context.Background())
		os.Exit(0)
	}()
}

func (s *Server) handleWarmup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	type WarmupReq struct {
		SystemPrompt string `json:"system_prompt,omitempty"`
		Model        string `json:"model,omitempty"`
	}
	var req WarmupReq
	_ = json.NewDecoder(r.Body).Decode(&req)

	go func() {
		if req.Model != "" {
			sys := req.SystemPrompt
			if sys == "" {
				sys = "You are a concise, helpful coding assistant."
			}
			s.WarmupModel(req.Model, sys)
		} else {
			s.WarmupFrontman()
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "warmup_initiated",
		"message": "KV cache prefill warmup running in background",
	})
}

func (s *Server) WarmupFrontman() {
	time.Sleep(1 * time.Second) // wait for server listener and llama-server
	if s.cfg.Roles.Chat.ModelID == "" {
		return
	}
	log.Printf("[meepo] Initiating KV cache prefill warmup for frontman (%s)...", s.cfg.Roles.Chat.ModelID)
	s.WarmupModel(s.cfg.Roles.Chat.ModelID, "You are a concise, helpful coding assistant and frontman.")
	log.Printf("[meepo] Frontman KV cache prefill warmup complete.")
}

func (s *Server) WarmupModel(modelID, sysPrompt string) {
	reqBody := map[string]interface{}{
		"model": modelID,
		"messages": []map[string]string{
			{"role": "system", "content": sysPrompt},
			{"role": "user", "content": "ready"},
		},
		"max_tokens": 1,
	}

	b, _ := json.Marshal(reqBody)
	resp, err := s.httpClient.Post(
		s.cfg.LlamaServer.BaseURL+"/chat/completions",
		"application/json",
		bytes.NewReader(b),
	)
	if err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	// Ping llama-server
	llamaOnline := false
	resp, err := s.httpClient.Get(s.cfg.LlamaServer.BaseURL + "/models")
	if err == nil && resp.StatusCode == http.StatusOK {
		llamaOnline = true
		resp.Body.Close()
	}

	// Ping Von
	vonOnline := false
	vResp, vErr := s.httpClient.Get(strings.Replace(s.cfg.Roles.Router.Endpoint, "/v1/systemone", "/v1/health", 1))
	if vErr == nil && (vResp.StatusCode == http.StatusOK || vResp.StatusCode == http.StatusNotFound || vResp.StatusCode == 422) {
		vonOnline = true
		vResp.Body.Close()
	}

	status := "healthy"
	if !llamaOnline || !vonOnline {
		status = "degraded"
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":       status,
		"orchestrator": "meepo",
		"version":      "0.1.0",
		"llamaOnline":    llamaOnline,
		"vonOnline":      vonOnline,
		"warmupPrefill":  s.cfg.Policy.WarmupPrefill,
	})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"object": "list",
		"data": []map[string]interface{}{
			{
				"id":           "meepo",
				"object":       "model",
				"created":      1733234400,
				"owned_by":     "meepo",
				"status":       map[string]string{"value": "loaded"},
				"architecture": map[string]interface{}{"input_modalities": []string{"text", "image"}, "output_modalities": []string{"text"}},
				"meta":         map[string]int{"n_ctx": 131072, "n_ctx_train": 131072},
			},
			{
				"id":           "mesh",
				"object":       "model",
				"created":      1733234400,
				"owned_by":     "meepo",
				"status":       map[string]string{"value": "loaded"},
				"architecture": map[string]interface{}{"input_modalities": []string{"text", "image"}, "output_modalities": []string{"text"}},
				"meta":         map[string]int{"n_ctx": 131072, "n_ctx_train": 131072},
			},
		},
	})
}

func (s *Server) handleProps(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"models_autoload": true,
		"chat_template":   "enable_thinking",
	})
}

func (s *Server) handleModelsLoad(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok"})
}

func (s *Server) handleModelsUnload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok"})
}

func (s *Server) handleModelsSSE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if ok {
		flusher.Flush()
	}

	fmt.Fprintf(w, "data: {\"model\":\"meepo\",\"event\":\"model_status\",\"data\":{\"status\":\"loaded\"}}\n\n")
	if ok {
		flusher.Flush()
	}
}

type ChatMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Name       string          `json:"name,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	ToolCalls  []interface{}   `json:"tool_calls,omitempty"`
}

type FunctionDefinition struct {
	Name        string      `json:"name"`
	Description string      `json:"description,omitempty"`
	Parameters  interface{} `json:"parameters,omitempty"`
}

type Tool struct {
	Type     string             `json:"type"`
	Function FunctionDefinition `json:"function"`
}

type ChatCompletionRequest struct {
	Model               string          `json:"model"`
	Messages            []ChatMessage   `json:"messages"`
	Tools               []Tool          `json:"tools,omitempty"`
	Stream              bool            `json:"stream,omitempty"`
	Temperature         *float64        `json:"temperature,omitempty"`
	MaxTokens           *int            `json:"max_tokens,omitempty"`
	MaxCompletionTokens *int            `json:"max_completion_tokens,omitempty"`
	AdditionalFields    json.RawMessage `json:"-"`
}

func sendToolCallChunk(w http.ResponseWriter, flusher http.Flusher, call map[string]interface{}) {
	chunk1 := map[string]interface{}{
		"id":      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   "meepo",
		"choices": []map[string]interface{}{
			{
				"index": 0,
				"delta": map[string]interface{}{
					"role":       "assistant",
					"tool_calls": []interface{}{call},
				},
				"finish_reason": nil,
			},
		},
	}
	b1, _ := json.Marshal(chunk1)
	fmt.Fprintf(w, "data: %s\n\n", b1)

	chunk2 := map[string]interface{}{
		"id":      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   "meepo",
		"choices": []map[string]interface{}{
			{
				"index":         0,
				"delta":         map[string]interface{}{},
				"finish_reason": "tool_calls",
			},
		},
	}
	b2, _ := json.Marshal(chunk2)
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b2)
	if flusher != nil {
		flusher.Flush()
	}
}
func sendReasoningChunk(w http.ResponseWriter, flusher http.Flusher, text string) {
	if text == "" {
		return
	}
	chunk := map[string]interface{}{
		"id":      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   "meepo",
		"choices": []map[string]interface{}{
			{
				"index": 0,
				"delta": map[string]interface{}{
					"role":              "assistant",
					"reasoning_content": text,
				},
				"finish_reason": nil,
			},
		},
	}
	b, _ := json.Marshal(chunk)
	fmt.Fprintf(w, "data: %s\n\n", b)
	if flusher != nil {
		flusher.Flush()
	}
}

func sendContentChunk(w http.ResponseWriter, flusher http.Flusher, text string) {
	chunk1 := map[string]interface{}{
		"id":      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   "meepo",
		"choices": []map[string]interface{}{
			{
				"index": 0,
				"delta": map[string]interface{}{
					"role":    "assistant",
					"content": text,
				},
				"finish_reason": nil,
			},
		},
	}
	b1, _ := json.Marshal(chunk1)
	fmt.Fprintf(w, "data: %s\n\n", b1)

	chunk2 := map[string]interface{}{
		"id":      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   "meepo",
		"choices": []map[string]interface{}{
			{
				"index":         0,
				"delta":         map[string]interface{}{},
				"finish_reason": "stop",
			},
		},
	}
	b2, _ := json.Marshal(chunk2)
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b2)
	if flusher != nil {
		flusher.Flush()
	}
}

func appendDirective(raw json.RawMessage, directive string) json.RawMessage {
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		out, _ := json.Marshal(str + directive)
		return out
	}
	var blocks []map[string]interface{}
	if err := json.Unmarshal(raw, &blocks); err == nil && len(blocks) > 0 {
		lastIdx := len(blocks) - 1
		if txt, ok := blocks[lastIdx]["text"].(string); ok {
			blocks[lastIdx]["text"] = txt + directive
		}
		out, _ := json.Marshal(blocks)
		return out
	}
	return raw
}

func extractBashCommand(content string) string {
	re := regexp.MustCompile("(?s)```(?:bash|sh)?\n(.*?)\n```")
	matches := re.FindStringSubmatch(content)
	if len(matches) > 1 {
		return strings.TrimSpace(matches[1])
	}
	return ""
}

func sanitizeTaskCommand(task string) string {
	cmd := strings.TrimSpace(task)
	cmd = strings.Trim(cmd, "`\"'")
	lower := strings.ToLower(cmd)
	if strings.HasPrefix(lower, "run command ") {
		cmd = strings.TrimSpace(cmd[12:])
	} else if strings.HasPrefix(lower, "run ") {
		cmd = strings.TrimSpace(cmd[4:])
	} else if strings.HasPrefix(lower, "execute ") {
		cmd = strings.TrimSpace(cmd[8:])
	}
	return cmd
}

func (s *Server) dispatchMeepoTools(ctx context.Context, task string, operationalTools []Tool) (map[string]interface{}, error) {
	cleanedTask := sanitizeTaskCommand(task)
	reqBody := map[string]interface{}{
		"model": s.cfg.Roles.Tools.ModelID,
		"messages": []map[string]string{
			{
				"role":    "system",
				"content": "You are meepo-tools, an expert Linux system administrator and execution engine. Translate the user goal into the most effective Linux terminal command or tool call (e.g. bash, read, write, edit) to achieve the goal. Always call the appropriate tool immediately without conversational filler.",
			},
			{
				"role":    "user",
				"content": cleanedTask,
			},
		},
		"tools":       operationalTools,
		"max_tokens":  250,
		"temperature": 0.1,
		"stream":      false,
	}

	b, _ := json.Marshal(reqBody)
	req, err := http.NewRequestWithContext(ctx, "POST", s.cfg.LlamaServer.BaseURL+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var respMap map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&respMap); err != nil {
		return nil, err
	}

	choices, _ := respMap["choices"].([]interface{})
	if len(choices) > 0 {
		firstChoice, _ := choices[0].(map[string]interface{})
		msg, _ := firstChoice["message"].(map[string]interface{})

		// Structured tool_calls
		if tcs, ok := msg["tool_calls"].([]interface{}); ok && len(tcs) > 0 {
			tcMap, _ := tcs[0].(map[string]interface{})
			id, _ := tcMap["id"].(string)
			if id == "" {
				id = fmt.Sprintf("call_%d", time.Now().UnixNano())
			}
			fn, _ := tcMap["function"].(map[string]interface{})
			name, _ := fn["name"].(string)
			args, _ := fn["arguments"].(string)

			return map[string]interface{}{
				"id":   id,
				"type": "function",
				"function": map[string]interface{}{
					"name":      name,
					"arguments": args,
				},
			}, nil
		}

		// Text fallback
		if content, ok := msg["content"].(string); ok && content != "" {
			if call, _ := extractToolCall(content); call != nil {
				return call, nil
			}
			cmd := extractBashCommand(content)
			if cmd != "" {
				argsJSON, _ := json.Marshal(map[string]string{"command": cmd})
				return map[string]interface{}{
					"id":   fmt.Sprintf("call_%d", time.Now().UnixNano()),
					"type": "function",
					"function": map[string]interface{}{
						"name":      "bash",
						"arguments": string(argsJSON),
					},
				}, nil
			}
		}
	}

	// Safe fallback to sanitized command
	if cleanedTask != "" {
		argsJSON, _ := json.Marshal(map[string]string{"command": cleanedTask})
		return map[string]interface{}{
			"id":   fmt.Sprintf("call_%d", time.Now().UnixNano()),
			"type": "function",
			"function": map[string]interface{}{
				"name":      "bash",
				"arguments": string(argsJSON),
			},
		}, nil
	}

	return nil, fmt.Errorf("no tool call generated by meepo-tools")
}

func (s *Server) dispatchMeepoCode(ctx context.Context, language, task string) (string, error) {
	reqBody := map[string]interface{}{
		"model": s.cfg.Roles.Code.ModelID,
		"messages": []map[string]string{
			{
				"role":    "system",
				"content": "You are meepo-code, a surgical code synthesis engine. Output clean, syntactically correct code without fluff.",
			},
			{
				"role":    "user",
				"content": fmt.Sprintf("Language: %s\nTask: %s", language, task),
			},
		},
		"max_tokens":  2048,
		"temperature": 0.2,
		"stream":      false,
	}

	b, _ := json.Marshal(reqBody)
	req, err := http.NewRequestWithContext(ctx, "POST", s.cfg.LlamaServer.BaseURL+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var respMap map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&respMap); err != nil {
		return "", err
	}

	choices, _ := respMap["choices"].([]interface{})
	if len(choices) > 0 {
		firstChoice, _ := choices[0].(map[string]interface{})
		msg, _ := firstChoice["message"].(map[string]interface{})
		if content, ok := msg["content"].(string); ok {
			return content, nil
		}
	}

	return "", fmt.Errorf("no code generated by meepo-code")
}
func extractLastUserPrompt(messages []ChatMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			var text string
			if err := json.Unmarshal(messages[i].Content, &text); err == nil {
				return text
			}
			var blocks []map[string]interface{}
			if err := json.Unmarshal(messages[i].Content, &blocks); err == nil {
				var sb strings.Builder
				for _, b := range blocks {
					if t, ok := b["text"].(string); ok {
						sb.WriteString(t)
						sb.WriteString(" ")
					}
				}
				return strings.TrimSpace(sb.String())
			}
			return string(messages[i].Content)
		}
	}
	return ""
}

func (s *Server) handleConductorCompletion(w http.ResponseWriter, r *http.Request, req ChatCompletionRequest) {
	// 0. Auxiliate with Von System One reflex (<25ms)
	var availableTools []string
	for _, t := range req.Tools {
		availableTools = append(availableTools, t.Function.Name)
	}
	userPrompt := extractLastUserPrompt(req.Messages)
	decision := s.router.RouteTurn(r.Context(), userPrompt, availableTools)
	var vonTrace string
	if decision.TargetRole != "" && decision.Confidence > 0 {
		vonTrace = fmt.Sprintf("[Von System One]: intent=%s (confidence: %.2f via %s)\n", decision.TargetRole, decision.Confidence, decision.Source)
	}

	// 1. Separate operational tools (held for LFM) from conversational tools (safe for Gemma)
	var operationalTools []Tool
	// Filter operational tools to only those allowed for the tools role (avoids schema cliff)
	toolsAllow := map[string]bool{
		"bash":           true,
		"read":           true,
		"write":          true,
		"edit":           true,
		"undo_last_edit": true,
		"codemode":       true,
	}
	for _, t := range req.Tools {
		if toolsAllow[t.Function.Name] {
			operationalTools = append(operationalTools, t)
		}
	}

	// 2. Frontman meta-tools exposed to Gemma
	frontmanTools := []Tool{
		{
			Type: "function",
			Function: FunctionDefinition{
				Name:        "meepo_tools",
				Description: "Delegate shell commands, terminal tools, system inspection, or filesystem operations to meepo-tools (LFM). State the operational goal or task clearly (e.g. 'check available memory and swap', 'inspect port 8080', 'read package.json', 'run tests'). LFM will autonomously select and run the appropriate tools.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"task": map[string]interface{}{
							"type":        "string",
							"description": "Operational goal, inspection task, or command",
						},
					},
					"required": []string{"task"},
				},
			},
		},
		{
			Type: "function",
			Function: FunctionDefinition{
				Name:        "meepo_code",
				Description: "Delegate code implementation, function writing, algorithms, or syntax refactoring to the meepo-code engine (Qwen).",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"language": map[string]interface{}{
							"type":        "string",
							"description": "Target programming language (e.g. go, typescript, python)",
						},
						"task": map[string]interface{}{
							"type":        "string",
							"description": "Exact implementation requirements or function specification",
						},
					},
					"required": []string{"language", "task"},
				},
			},
		},
		{
			Type: "function",
			Function: FunctionDefinition{
				Name:        "meepo_cloud",
				Description: "Escalate complex distributed systems deadlocks, multi-threaded race conditions, or hard architectural dilemmas to the non-local Claude Opus model.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"problem": map[string]interface{}{
							"type":        "string",
							"description": "Clear statement of the architectural dilemma, deadlock, or race condition",
						},
					},
					"required": []string{"problem"},
				},
			},
		},
	}

	for _, t := range req.Tools {
		if t.Function.Name == "ask" || t.Function.Name == "web_search" || t.Function.Name == "web_fetch" {
			frontmanTools = append(frontmanTools, t)
		}
	}

	// 3. Clean system messages and append Frontman Directive
	frontmanDirective := "\n\n[Meepo Frontman Mode]:\nYou are the conversational frontman for the Meepo Multi-Brain mesh. The user speaks directly to you.\n- For general conversation, conceptual explanations, or answering questions: answer directly in your persona.\n- For terminal commands, system stats, files, or environment tasks: call meepo_tools with the operational goal.\n- For code generation, writing algorithms, or refactoring: call meepo_code.\n- For deep architectural dilemmas, deadlocks, or race conditions: call meepo_cloud.\n- When you receive tool results, synthesize and present the factual answer cleanly to the user in your persona."

	if decision.TargetRole != "" && decision.TargetRole != "chat" && decision.Confidence >= 0.70 {
		frontmanDirective += fmt.Sprintf("\n[System One Reflex]: Primary intent detected as '%s' (confidence: %.2f). If user needs action in this domain, delegate to the corresponding specialist.", decision.TargetRole, decision.Confidence)
	}

	for i := range req.Messages {
		if req.Messages[i].Role == "system" || req.Messages[i].Role == "developer" {
			req.Messages[i].Content = cleanSystemContent(req.Messages[i].Content, frontmanTools)
			req.Messages[i].Content = appendDirective(req.Messages[i].Content, frontmanDirective)
		}
	}

	// 4. Build upstream request targeting Frontman (Gemma)
	forwardedMap := map[string]interface{}{
		"model":    s.cfg.Roles.Chat.ModelID,
		"messages": req.Messages,
		"tools":    frontmanTools,
		"stream":   req.Stream,
	}
	if req.Temperature != nil {
		forwardedMap["temperature"] = req.Temperature
	}
	if req.MaxTokens != nil {
		forwardedMap["max_tokens"] = req.MaxTokens
	}
	if req.MaxCompletionTokens != nil {
		forwardedMap["max_completion_tokens"] = req.MaxCompletionTokens
	}

	forwardedBytes, _ := json.Marshal(forwardedMap)
	upstreamReq, err := http.NewRequestWithContext(r.Context(), "POST", s.cfg.LlamaServer.BaseURL+"/chat/completions", bytes.NewReader(forwardedBytes))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")

	upstreamResp, err := s.httpClient.Do(upstreamReq)
	if err != nil {
		http.Error(w, "Upstream llama-server error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer upstreamResp.Body.Close()

	if upstreamResp.StatusCode != http.StatusOK {
		w.WriteHeader(upstreamResp.StatusCode)
		io.Copy(w, upstreamResp.Body)
		return
	}

	// 5A. Non-Streaming Handling
	if !req.Stream {
		var respMap map[string]interface{}
		if err := json.NewDecoder(upstreamResp.Body).Decode(&respMap); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		var traceLog strings.Builder
		if vonTrace != "" {
			traceLog.WriteString(vonTrace)
		}

		choices, _ := respMap["choices"].([]interface{})
		if len(choices) > 0 {
			firstChoice, _ := choices[0].(map[string]interface{})
			msg, _ := firstChoice["message"].(map[string]interface{})
			toolCalls, _ := msg["tool_calls"].([]interface{})

			if len(toolCalls) > 0 {
				tcMap, _ := toolCalls[0].(map[string]interface{})
				fn, _ := tcMap["function"].(map[string]interface{})
				fnName, _ := fn["name"].(string)
				argsStr, _ := fn["arguments"].(string)

				if fnName == "meepo_tools" {
					var argsObj map[string]interface{}
					task := argsStr
					if err := json.Unmarshal([]byte(argsStr), &argsObj); err == nil {
						if t, ok := argsObj["task"].(string); ok && t != "" {
							task = t
						}
					}
					traceLog.WriteString(fmt.Sprintf("[meepo-tools]: Delegating to LFM 2.5: %q...\n", task))
					lfmCall, err := s.dispatchMeepoTools(r.Context(), task, operationalTools)
					if err == nil && lfmCall != nil {
						fnLFM, _ := lfmCall["function"].(map[string]interface{})
						lfmFnName, _ := fnLFM["name"].(string)
						lfmArgs, _ := fnLFM["arguments"].(string)
						traceLog.WriteString(fmt.Sprintf("[meepo-tools]: LFM 2.5 selected: %s(%s)\n", lfmFnName, lfmArgs))
						msg["tool_calls"] = []interface{}{lfmCall}
						firstChoice["finish_reason"] = "tool_calls"
					}
				} else if fnName == "meepo_code" {
					var argsObj map[string]interface{}
					lang := "code"
					task := argsStr
					if err := json.Unmarshal([]byte(argsStr), &argsObj); err == nil {
						if l, ok := argsObj["language"].(string); ok && l != "" {
							lang = l
						}
						if t, ok := argsObj["task"].(string); ok && t != "" {
							task = t
						}
					}
					traceLog.WriteString(fmt.Sprintf("[meepo-code]: Delegating to Qwen 3.5 (%s): %q...\n", lang, task))
					qwenCode, err := s.dispatchMeepoCode(r.Context(), lang, task)
					if err == nil && qwenCode != "" {
						traceLog.WriteString(fmt.Sprintf("[meepo-code]: Qwen 3.5 generated %d bytes of code\n", len(qwenCode)))
						msg["content"] = qwenCode
						delete(msg, "tool_calls")
						firstChoice["finish_reason"] = "stop"
					}
				} else if fnName == "meepo_cloud" {
					var argsObj map[string]interface{}
					problem := argsStr
					if err := json.Unmarshal([]byte(argsStr), &argsObj); err == nil {
						if p, ok := argsObj["problem"].(string); ok && p != "" {
							problem = p
						}
					}
					traceLog.WriteString(fmt.Sprintf("[meepo-cloud]: Escalating to Claude Opus: %q...\n", problem))
					verdict, err := s.consultCloudAdvisor(r.Context(), problem)
					if err == nil && verdict != "" {
						traceLog.WriteString(fmt.Sprintf("[meepo-cloud]: Received Opus verdict (%d bytes)\n", len(verdict)))
						msg["content"] = verdict
						delete(msg, "tool_calls")
						firstChoice["finish_reason"] = "stop"
					}
				}
			}

			if traceLog.Len() > 0 {
				existingReasoning, _ := msg["reasoning_content"].(string)
				if existingReasoning != "" {
					msg["reasoning_content"] = strings.TrimSpace(traceLog.String()) + "\n\n" + existingReasoning
				} else {
					msg["reasoning_content"] = strings.TrimSpace(traceLog.String())
				}
			}
		}

		respMap["model"] = "meepo"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(respMap)
		return
	}

	// 5B. Streaming Handling
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, hasFlusher := w.(http.Flusher)
	if hasFlusher {
		flusher.Flush()
	}

	if vonTrace != "" {
		sendReasoningChunk(w, flusher, vonTrace)
	}
	reader := bufio.NewReader(upstreamResp.Body)
	var isToolCall bool
	var toolCallName string
	var toolCallID string
	var toolCallArgs strings.Builder

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}

		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data: ") {
			continue
		}

		if trimmed == "data: [DONE]" {
			if isToolCall {
				argsStr := toolCallArgs.String()
				if toolCallName == "meepo_tools" {
					var argsObj map[string]interface{}
					task := argsStr
					if err := json.Unmarshal([]byte(argsStr), &argsObj); err == nil {
						if t, ok := argsObj["task"].(string); ok && t != "" {
							task = t
						}
					}
					sendReasoningChunk(w, flusher, fmt.Sprintf("[meepo-tools]: Delegating to LFM 2.5: %q...\n", task))
					lfmCall, err := s.dispatchMeepoTools(r.Context(), task, operationalTools)
					if err == nil && lfmCall != nil {
						fnLFM, _ := lfmCall["function"].(map[string]interface{})
						lfmFnName, _ := fnLFM["name"].(string)
						lfmArgs, _ := fnLFM["arguments"].(string)
						sendReasoningChunk(w, flusher, fmt.Sprintf("[meepo-tools]: LFM 2.5 selected: %s(%s)\n\n", lfmFnName, lfmArgs))
						sendToolCallChunk(w, flusher, lfmCall)
						return
					}
					// Fallback: bash execution
					argsJSON, _ := json.Marshal(map[string]string{"command": task})
					fallbackCall := map[string]interface{}{
						"id":   fmt.Sprintf("call_%d", time.Now().UnixNano()),
						"type": "function",
						"function": map[string]interface{}{
							"name":      "bash",
							"arguments": string(argsJSON),
						},
					}
					sendReasoningChunk(w, flusher, fmt.Sprintf("[meepo-tools]: Fallback direct bash: %s\n\n", task))
					sendToolCallChunk(w, flusher, fallbackCall)
					return
				} else if toolCallName == "meepo_code" {
					var argsObj map[string]interface{}
					lang := "code"
					task := argsStr
					if err := json.Unmarshal([]byte(argsStr), &argsObj); err == nil {
						if l, ok := argsObj["language"].(string); ok && l != "" {
							lang = l
						}
						if t, ok := argsObj["task"].(string); ok && t != "" {
							task = t
						}
					}
					sendReasoningChunk(w, flusher, fmt.Sprintf("[meepo-code]: Delegating to Qwen 3.5 (%s): %q...\n", lang, task))
					qwenCode, err := s.dispatchMeepoCode(r.Context(), lang, task)
					if err == nil && qwenCode != "" {
						sendReasoningChunk(w, flusher, fmt.Sprintf("[meepo-code]: Qwen 3.5 generated %d bytes of code\n\n", len(qwenCode)))
						sendContentChunk(w, flusher, qwenCode)
						return
					}
				} else if toolCallName == "meepo_cloud" {
					var argsObj map[string]interface{}
					problem := argsStr
					if err := json.Unmarshal([]byte(argsStr), &argsObj); err == nil {
						if p, ok := argsObj["problem"].(string); ok && p != "" {
							problem = p
						}
					}
					sendReasoningChunk(w, flusher, fmt.Sprintf("[meepo-cloud]: Escalating to Claude Opus: %q...\n", problem))
					verdict, err := s.consultCloudAdvisor(r.Context(), problem)
					if err == nil && verdict != "" {
						sendReasoningChunk(w, flusher, fmt.Sprintf("[meepo-cloud]: Received Opus verdict (%d bytes)\n\n", len(verdict)))
						sendContentChunk(w, flusher, verdict)
						return
					}
				} else if toolCallName != "" {
					directCall := map[string]interface{}{
						"id":   toolCallID,
						"type": "function",
						"function": map[string]interface{}{
							"name":      toolCallName,
							"arguments": argsStr,
						},
					}
					sendToolCallChunk(w, flusher, directCall)
					return
				}
			}

			fmt.Fprintf(w, "data: [DONE]\n\n")
			if hasFlusher {
				flusher.Flush()
			}
			break
		}

		dataJSON := strings.TrimPrefix(trimmed, "data: ")
		var chunkMap map[string]interface{}
		if err := json.Unmarshal([]byte(dataJSON), &chunkMap); err == nil {
			choices, _ := chunkMap["choices"].([]interface{})
			if len(choices) > 0 {
				choice, _ := choices[0].(map[string]interface{})
				delta, _ := choice["delta"].(map[string]interface{})

				// Check tool call delta
				if tcList, ok := delta["tool_calls"].([]interface{}); ok && len(tcList) > 0 {
					isToolCall = true
					tcMap, _ := tcList[0].(map[string]interface{})
					if id, ok := tcMap["id"].(string); ok && id != "" {
						toolCallID = id
					}
					if fn, ok := tcMap["function"].(map[string]interface{}); ok {
						if name, ok := fn["name"].(string); ok && name != "" {
							toolCallName = name
						}
						if args, ok := fn["arguments"].(string); ok {
							toolCallArgs.WriteString(args)
						}
					}
					continue
				}

				if !isToolCall {
					chunkMap["model"] = "meepo"
					outBytes, _ := json.Marshal(chunkMap)
					fmt.Fprintf(w, "data: %s\n\n", outBytes)
					if hasFlusher {
						flusher.Flush()
					}
				}
			}
		}
	}
}

func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var req ChatCompletionRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	reqModel := req.Model
	if reqModel == "" {
		reqModel = "meepo"
	}

	// Conductor Mode: user always speaks to meepo-chat (Gemma) which delegates to sub-brains
	isConductor := reqModel == "meepo" || reqModel == "mesh" || reqModel == "meepo/mesh" || reqModel == "meepo/meepo" || reqModel == "meepo-mesh"
	if isConductor {
		s.handleConductorCompletion(w, r, req)
		return
	}
	targetRole := "chat"
	if strings.Contains(reqModel, "chat") {
		targetRole = "chat"
	} else if strings.Contains(reqModel, "tools") {
		targetRole = "tools"
	} else if strings.Contains(reqModel, "code") {
		targetRole = "code"
	} else if strings.Contains(reqModel, "cloud") {
		targetRole = "cloud"
	}

	// 2. Prune Tools
	var availableTools []string
	for _, t := range req.Tools {
		availableTools = append(availableTools, t.Function.Name)
	}
	pruning := s.router.CalculateToolPruning(targetRole, availableTools)
	allowedSet := make(map[string]bool)
	for _, a := range pruning.Allowed {
		allowedSet[a] = true
	}

	var prunedTools []Tool
	for _, t := range req.Tools {
		if allowedSet[t.Function.Name] {
			prunedTools = append(prunedTools, t)
		}
	}

	// 3. Strip System Message Bloat (Skills, Docs, Distractor tool text)
	// 3. Strip System Message Bloat (Skills, Docs, Distractor tool text)
	for i := range req.Messages {
		if req.Messages[i].Role == "system" || req.Messages[i].Role == "developer" {
			req.Messages[i].Content = cleanSystemContent(req.Messages[i].Content, prunedTools)
		}
	}

	// 4. Map Target Model ID
	targetModelID := s.cfg.Roles.Chat.ModelID
	switch targetRole {
	case "chat":
		targetModelID = s.cfg.Roles.Chat.ModelID
	case "tools":
		targetModelID = s.cfg.Roles.Tools.ModelID
	case "code":
		targetModelID = s.cfg.Roles.Code.ModelID
	case "cloud":
		targetModelID = s.cfg.Roles.Cloud.ModelID
	}

	// 5. Cloud Escalation Handler
	if targetRole == "cloud" {
		userPrompt := extractUserPrompt(req.Messages)
		verdict, err := s.consultCloudAdvisor(r.Context(), userPrompt)
		if err != nil {
			http.Error(w, "Cloud advisor error: "+err.Error(), http.StatusInternalServerError)
			return
		}

		if !req.Stream {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id":      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
				"object":  "chat.completion",
				"created": time.Now().Unix(),
				"model":   fmt.Sprintf("meepo-%s (%s)", targetRole, targetModelID),
				"choices": []map[string]interface{}{
					{
						"index":         0,
						"message":       map[string]string{"role": "assistant", "content": verdict},
						"finish_reason": "stop",
					},
				},
			})
			return
		}

		// SSE Streaming Cloud Verdict
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		flusher, ok := w.(http.Flusher)
		if ok {
			flusher.Flush()
		}

		chunkID := fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano())
		chunk1 := map[string]interface{}{
			"id":      chunkID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   fmt.Sprintf("meepo-%s (%s)", targetRole, targetModelID),
			"choices": []map[string]interface{}{
				{"index": 0, "delta": map[string]string{"role": "assistant", "content": verdict}, "finish_reason": nil},
			},
		}
		b1, _ := json.Marshal(chunk1)
		fmt.Fprintf(w, "data: %s\n\n", b1)
		if ok {
			flusher.Flush()
		}

		chunk2 := map[string]interface{}{
			"id":      chunkID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   fmt.Sprintf("meepo-%s (%s)", targetRole, targetModelID),
			"choices": []map[string]interface{}{
				{"index": 0, "delta": map[string]string{}, "finish_reason": "stop"},
			},
		}
		b2, _ := json.Marshal(chunk2)
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b2)
		if ok {
			flusher.Flush()
		}
		return
	}

	// 6. Forward Request to Local llama-server
	var forwardedMap map[string]interface{}
	json.Unmarshal(bodyBytes, &forwardedMap)
	forwardedMap["model"] = targetModelID
	forwardedMap["messages"] = req.Messages
	if len(prunedTools) > 0 {
		forwardedMap["tools"] = prunedTools
	} else {
		delete(forwardedMap, "tools")
		delete(forwardedMap, "tool_choice")
	}

	forwardedBytes, _ := json.Marshal(forwardedMap)
	upstreamReq, err := http.NewRequestWithContext(r.Context(), "POST", s.cfg.LlamaServer.BaseURL+"/chat/completions", bytes.NewReader(forwardedBytes))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")

	upstreamResp, err := s.httpClient.Do(upstreamReq)
	if err != nil {
		http.Error(w, "Upstream llama-server error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer upstreamResp.Body.Close()

	if upstreamResp.StatusCode != http.StatusOK {
		w.WriteHeader(upstreamResp.StatusCode)
		io.Copy(w, upstreamResp.Body)
		return
	}

	// 7A. Non-streaming Response
	if !req.Stream {
		var respMap map[string]interface{}
		if err := json.NewDecoder(upstreamResp.Body).Decode(&respMap); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Auto-heal tool call
		choices, _ := respMap["choices"].([]interface{})
		if len(choices) > 0 {
			firstChoice, _ := choices[0].(map[string]interface{})
			msg, _ := firstChoice["message"].(map[string]interface{})
			content, _ := msg["content"].(string)
			toolCalls, _ := msg["tool_calls"].([]interface{})

			if len(toolCalls) == 0 && strings.Contains(content, "<tool_call>") {
				if call, cleaned := extractToolCall(content); call != nil {
					msg["content"] = cleaned
					msg["tool_calls"] = []interface{}{call}
					firstChoice["finish_reason"] = "tool_calls"
				}
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(respMap)
		return
	}

	// 7B. Streaming SSE Response with Auto-Healing Bridge
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, hasFlusher := w.(http.Flusher)
	if hasFlusher {
		flusher.Flush()
	}

	reader := bufio.NewReader(upstreamResp.Body)
	var accumulatedContent string
	var sentToolCall bool

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}

		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data: ") {
			continue
		}

		if trimmed == "data: [DONE]" {
			// Check if we need to auto-heal leaked tool call
			if !sentToolCall && strings.Contains(accumulatedContent, "<tool_call>") {
				if call, _ := extractToolCall(accumulatedContent); call != nil {
					sentToolCall = true
					toolChunk := map[string]interface{}{
						"id":      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
						"object":  "chat.completion.chunk",
						"created": time.Now().Unix(),
						"model":   fmt.Sprintf("meepo-%s (%s)", targetRole, targetModelID),
						"choices": []map[string]interface{}{
							{
								"index": 0,
								"delta": map[string]interface{}{
									"role":       "assistant",
									"tool_calls": []interface{}{call},
								},
								"finish_reason": "tool_calls",
							},
						},
					}
					b, _ := json.Marshal(toolChunk)
					fmt.Fprintf(w, "data: %s\n\n", b)
					if hasFlusher {
						flusher.Flush()
					}
				}
			}

			fmt.Fprintf(w, "data: [DONE]\n\n")
			if hasFlusher {
				flusher.Flush()
			}
			break
		}

		dataJSON := strings.TrimPrefix(trimmed, "data: ")
		var chunkMap map[string]interface{}
		if err := json.Unmarshal([]byte(dataJSON), &chunkMap); err == nil {
			choices, _ := chunkMap["choices"].([]interface{})
			if len(choices) > 0 {
				choice, _ := choices[0].(map[string]interface{})
				delta, _ := choice["delta"].(map[string]interface{})
				if c, ok := delta["content"].(string); ok {
					accumulatedContent += c
				}
				if tc, ok := delta["tool_calls"].([]interface{}); ok && len(tc) > 0 {
					sentToolCall = true
				}
			}
		}

		fmt.Fprintf(w, "%s\n\n", trimmed)
		if hasFlusher {
			flusher.Flush()
		}
	}
}

func cleanPromptString(text string, prunedTools []Tool) string {
	skillsRegex := regexp.MustCompile(`(?s)<skills>.*?</skills>`)
	availSkillsRegex := regexp.MustCompile(`(?s)<available_skills>.*?</available_skills>`)
	docsRegex := regexp.MustCompile(`(?s)<docs>.*?</docs>`)
	toolsRegex := regexp.MustCompile(`(?s)<tools>.*?</tools>`)

	cleaned := skillsRegex.ReplaceAllString(text, "")
	cleaned = availSkillsRegex.ReplaceAllString(cleaned, "")
	cleaned = docsRegex.ReplaceAllString(cleaned, "")

	if strings.Contains(cleaned, "<tools>") {
		if len(prunedTools) > 0 {
			var tLines []string
			for _, t := range prunedTools {
				tLines = append(tLines, fmt.Sprintf("- %s: %s", t.Function.Name, t.Function.Description))
			}
			cleaned = toolsRegex.ReplaceAllString(cleaned, fmt.Sprintf("<tools>\n%s\n</tools>", strings.Join(tLines, "\n")))
		} else {
			cleaned = toolsRegex.ReplaceAllString(cleaned, "")
		}
	}
	return strings.TrimSpace(cleaned)
}

func cleanSystemContent(raw json.RawMessage, prunedTools []Tool) json.RawMessage {
	// 1. Try as direct string
	var rawStr string
	if err := json.Unmarshal(raw, &rawStr); err == nil {
		cleaned := cleanPromptString(rawStr, prunedTools)
		newContent, _ := json.Marshal(cleaned)
		return newContent
	}

	// 2. Try as array of content blocks (used by Pi for structured transcripts)
	var blocks []map[string]interface{}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		for i := range blocks {
			if t, ok := blocks[i]["type"].(string); ok && t == "text" {
				if txt, ok := blocks[i]["text"].(string); ok {
					blocks[i]["text"] = cleanPromptString(txt, prunedTools)
				}
			}
		}
		newContent, _ := json.Marshal(blocks)
		return newContent
	}

	return raw
}
func extractUserPrompt(messages []ChatMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			var text string
			if err := json.Unmarshal(messages[i].Content, &text); err == nil {
				return text
			}
			// Array of content blocks
			var blocks []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if err := json.Unmarshal(messages[i].Content, &blocks); err == nil {
				var parts []string
				for _, b := range blocks {
					if b.Type == "text" && b.Text != "" {
						parts = append(parts, b.Text)
					}
				}
				return strings.Join(parts, "\n")
			}
		}
	}
	return ""
}

func (s *Server) consultCloudAdvisor(ctx context.Context, prompt string) (string, error) {
	cmd := exec.CommandContext(ctx, "pi", "--mode", "json", "-p", "--no-session", "--no-extensions", "--no-tools", "--model", s.cfg.Roles.Cloud.ModelID, prompt)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("pi cloud execution: %w", err)
	}

	lines := strings.Split(string(out), "\n")
	var verdict string
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed == "" {
			continue
		}
		var parsed struct {
			Type    string `json:"type"`
			Message struct {
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
			if parsed.Type == "message" && parsed.Message.Role == "assistant" {
				var texts []string
				for _, c := range parsed.Message.Content {
					if c.Type == "text" {
						texts = append(texts, c.Text)
					}
				}
				if len(texts) > 0 {
					verdict = strings.Join(texts, "\n")
				}
			}
		}
	}

	if verdict == "" {
		verdict = strings.TrimSpace(string(out))
	}
	return verdict, nil
}

func extractToolCall(text string) (map[string]interface{}, string) {
	tagIdx := strings.Index(text, "<tool_call>")
	if tagIdx == -1 {
		return nil, text
	}
	startBrace := strings.Index(text[tagIdx:], "{")
	if startBrace == -1 {
		return nil, text
	}
	startBrace += tagIdx

	depth := 0
	endBrace := -1
	inString := false
	escape := false

	for i := startBrace; i < len(text); i++ {
		char := text[i]
		if escape {
			escape = false
			continue
		}
		if char == '\\' {
			escape = true
			continue
		}
		if char == '"' && !escape {
			inString = !inString
			continue
		}
		if !inString {
			if char == '{' {
				depth++
			} else if char == '}' {
				depth--
				if depth == 0 {
					endBrace = i
					break
				}
			}
		}
	}

	if endBrace == -1 {
		return nil, text
	}

	jsonStr := text[startBrace : endBrace+1]
	var parsed struct {
		Name      string      `json:"name"`
		Arguments interface{} `json:"arguments"`
	}
	if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil || parsed.Name == "" {
		return nil, text
	}

	argsStr := ""
	switch a := parsed.Arguments.(type) {
	case string:
		argsStr = a
	default:
		b, _ := json.Marshal(a)
		argsStr = string(b)
	}

	call := map[string]interface{}{
		"id":   fmt.Sprintf("call_%d", time.Now().UnixNano()),
		"type": "function",
		"function": map[string]interface{}{
			"name":      parsed.Name,
			"arguments": argsStr,
		},
	}

	cutEnd := endBrace + 1
	if closeTag := strings.Index(text[endBrace:], "</tool_call>"); closeTag != -1 {
		cutEnd = endBrace + closeTag + len("</tool_call>")
	}

	cleaned := strings.TrimSpace(text[:tagIdx] + text[cutEnd:])
	return call, cleaned
}
