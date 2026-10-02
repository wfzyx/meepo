package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/wfzyx/meepo/pkg/config"
)

func TestServerEndpoints(t *testing.T) {
	cfg := config.DefaultConfig()
	srv := NewServer(cfg)
	addr := "127.0.0.1:8095"

	go func() {
		_ = srv.Start(addr)
	}()
	time.Sleep(100 * time.Millisecond)
	defer srv.Shutdown(context.Background())

	// 1. GET /health
	resp, err := http.Get("http://" + addr + "/health")
	if err != nil {
		t.Fatalf("GET /health failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var hMap map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&hMap)
	if hMap["orchestrator"] != "meepo" {
		t.Errorf("expected meepo orchestrator, got %v", hMap["orchestrator"])
	}

	// 2. GET /v1/models
	mResp, err := http.Get("http://" + addr + "/v1/models")
	if err != nil {
		t.Fatalf("GET /v1/models failed: %v", err)
	}
	defer mResp.Body.Close()
	if mResp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", mResp.StatusCode)
	}

	// 3. POST /v1/chat/completions (tools role, non-streaming)
	body := map[string]interface{}{
		"model": "tools",
		"messages": []map[string]interface{}{
			{"role": "user", "content": "echo hi"},
		},
		"stream":     false,
		"max_tokens": 10,
	}
	b, _ := json.Marshal(body)
	cResp, err := http.Post("http://"+addr+"/v1/chat/completions", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("POST /v1/chat/completions failed: %v", err)
	}
	defer cResp.Body.Close()
	if cResp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", cResp.StatusCode)
	}
}

func TestCleanSystemContent(t *testing.T) {
	prunedTools := []Tool{
		{
			Type: "function",
			Function: FunctionDefinition{
				Name:        "bash",
				Description: "Run shell commands",
			},
		},
	}

	rawText := `You are an agent.
<tools>
- read: Read files
- bash: Run shell commands
- edit: Edit files
- custom_tool: Some custom tool
</tools>
<docs>
Heavy documentation text
</docs>
<skills>
Skill definitions here
</skills>
<available_skills>
More skill info
</available_skills>
<rules>
Rule 1
Rule 2
</rules>`

	// 1. Test string format
	strBytes, _ := json.Marshal(rawText)
	cleanedStrBytes := cleanSystemContent(strBytes, prunedTools)
	var cleanedStr string
	if err := json.Unmarshal(cleanedStrBytes, &cleanedStr); err != nil {
		t.Fatalf("failed to unmarshal cleaned string: %v", err)
	}

	if bytes.Contains([]byte(cleanedStr), []byte("<skills>")) {
		t.Errorf("cleaned string still contains <skills>")
	}
	if bytes.Contains([]byte(cleanedStr), []byte("<available_skills>")) {
		t.Errorf("cleaned string still contains <available_skills>")
	}
	if bytes.Contains([]byte(cleanedStr), []byte("<docs>")) {
		t.Errorf("cleaned string still contains <docs>")
	}
	if !bytes.Contains([]byte(cleanedStr), []byte("- bash: Run shell commands")) {
		t.Errorf("cleaned string missing pruned bash tool")
	}
	if bytes.Contains([]byte(cleanedStr), []byte("- edit: Edit files")) {
		t.Errorf("cleaned string should have pruned edit tool")
	}

	// 2. Test block format (as sent by Pi)
	blocks := []map[string]interface{}{
		{"type": "text", "text": rawText},
	}
	blocksBytes, _ := json.Marshal(blocks)
	cleanedBlockBytes := cleanSystemContent(blocksBytes, prunedTools)
	var cleanedBlocks []map[string]interface{}
	if err := json.Unmarshal(cleanedBlockBytes, &cleanedBlocks); err != nil {
		t.Fatalf("failed to unmarshal cleaned blocks: %v", err)
	}

	if len(cleanedBlocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(cleanedBlocks))
	}
	bText := cleanedBlocks[0]["text"].(string)
	if bytes.Contains([]byte(bText), []byte("<skills>")) {
		t.Errorf("cleaned block still contains <skills>")
	}
	if bytes.Contains([]byte(bText), []byte("<docs>")) {
		t.Errorf("cleaned block still contains <docs>")
	}
	if !bytes.Contains([]byte(bText), []byte("- bash: Run shell commands")) {
		t.Errorf("cleaned block missing pruned bash tool")
	}
}

func TestSanitizeTaskCommand(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"run fastfetch", "fastfetch"},
		{"`run fastfetch`", "fastfetch"},
		{"execute ls -la", "ls -la"},
		{"run command free -m", "free -m"},
		{"get system memory throughput statistics", "get system memory throughput statistics"},
		{"check memory stats", "check memory stats"},
		{"get cpu processor info", "get cpu processor info"},
		{"cat /proc/meminfo", "cat /proc/meminfo"},
	}

	for _, tc := range tests {
		got := sanitizeTaskCommand(tc.input)
		if got != tc.expected {
			t.Errorf("sanitizeTaskCommand(%q) = %q; want %q", tc.input, got, tc.expected)
		}
	}
}
