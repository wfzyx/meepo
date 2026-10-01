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
