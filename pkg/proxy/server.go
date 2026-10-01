package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

	s.httpServer = &http.Server{
		Addr:    addr,
		Handler: corsMiddleware(mux),
	}

	return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	if s.httpServer != nil {
		return s.httpServer.Shutdown(ctx)
	}
	return nil
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
		"llamaOnline":  llamaOnline,
		"vonOnline":    vonOnline,
	})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"object": "list",
		"data": []map[string]interface{}{
			{
				"id":           "mesh",
				"object":       "model",
				"created":      1733234400,
				"owned_by":     "meepo",
				"status":       map[string]string{"value": "loaded"},
				"architecture": map[string]interface{}{"input_modalities": []string{"text", "image"}, "output_modalities": []string{"text"}},
				"meta":         map[string]int{"n_ctx": 131072, "n_ctx_train": 131072},
			},
			{
				"id":           "chat",
				"object":       "model",
				"created":      1733234400,
				"owned_by":     "meepo",
				"status":       map[string]string{"value": "loaded"},
				"architecture": map[string]interface{}{"input_modalities": []string{"text", "image"}, "output_modalities": []string{"text"}},
				"meta":         map[string]int{"n_ctx": 131072, "n_ctx_train": 131072},
			},
			{
				"id":           "tools",
				"object":       "model",
				"created":      1733234400,
				"owned_by":     "meepo",
				"status":       map[string]string{"value": "loaded"},
				"architecture": map[string]interface{}{"input_modalities": []string{"text"}, "output_modalities": []string{"text"}},
				"meta":         map[string]int{"n_ctx": 32768, "n_ctx_train": 32768},
			},
			{
				"id":           "code",
				"object":       "model",
				"created":      1733234400,
				"owned_by":     "meepo",
				"status":       map[string]string{"value": "loaded"},
				"architecture": map[string]interface{}{"input_modalities": []string{"text"}, "output_modalities": []string{"text"}},
				"meta":         map[string]int{"n_ctx": 32768, "n_ctx_train": 32768},
			},
			{
				"id":           "cloud",
				"object":       "model",
				"created":      1733234400,
				"owned_by":     "meepo",
				"status":       map[string]string{"value": "loaded"},
				"architecture": map[string]interface{}{"input_modalities": []string{"text"}, "output_modalities": []string{"text"}},
				"meta":         map[string]int{"n_ctx": 200000, "n_ctx_train": 200000},
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

	fmt.Fprintf(w, "data: {\"model\":\"mesh\",\"event\":\"model_status\",\"data\":{\"status\":\"loaded\"}}\n\n")
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

	// 1. Determine Target Role
	targetRole := "chat"
	reqModel := req.Model
	if reqModel == "" {
		reqModel = "mesh"
	}

	if reqModel == "mesh" || reqModel == "meepo/mesh" || reqModel == "meepo-mesh" {
		// Check if active tool loop
		var lastNonAssistant *ChatMessage
		for i := len(req.Messages) - 1; i >= 0; i-- {
			if req.Messages[i].Role != "assistant" {
				lastNonAssistant = &req.Messages[i]
				break
			}
		}

		if lastNonAssistant != nil && lastNonAssistant.Role == "tool" {
			targetRole = "tools"
		} else {
			// Check for image input
			hasImage := false
			for i := len(req.Messages) - 1; i >= 0; i-- {
				if req.Messages[i].Role == "user" {
					cStr := string(req.Messages[i].Content)
					if strings.Contains(cStr, `"type":"image"`) || strings.Contains(cStr, `"type":"image_url"`) {
						hasImage = true
					}
					break
				}
			}

			if hasImage {
				targetRole = "chat"
			} else {
				userPrompt := extractUserPrompt(req.Messages)
				var toolNames []string
				for _, t := range req.Tools {
					if t.Function.Name != "" {
						toolNames = append(toolNames, t.Function.Name)
					}
				}
				decision := s.router.RouteTurn(r.Context(), userPrompt, toolNames)
				targetRole = decision.TargetRole
			}
		}
	} else if strings.Contains(reqModel, "chat") {
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
	skillsRegex := regexp.MustCompile(`(?s)<skills>.*?</skills>`)
	docsRegex := regexp.MustCompile(`(?s)<docs>.*?</docs>`)
	toolsRegex := regexp.MustCompile(`(?s)<tools>.*?</tools>`)

	for i := range req.Messages {
		if i == 0 && req.Messages[i].Role == "system" {
			var rawStr string
			if err := json.Unmarshal(req.Messages[i].Content, &rawStr); err == nil {
				cleaned := skillsRegex.ReplaceAllString(rawStr, "")
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
				newContent, _ := json.Marshal(strings.TrimSpace(cleaned))
				req.Messages[i].Content = newContent
			}
			break
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
