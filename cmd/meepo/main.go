package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/wfzyx/meepo/pkg/config"
	"github.com/wfzyx/meepo/pkg/proxy"
)

func main() {
	if len(os.Args) < 2 {
		runServe(os.Args[1:])
		return
	}

	cmd := os.Args[1]
	switch cmd {
	case "serve", "start":
		runServe(os.Args[2:])
	case "status":
		runStatus(os.Args[2:])
	case "--help", "-h", "help":
		printHelp()
	default:
		// If flags passed directly without subcommand (e.g. `meepo --port 8081`)
		if len(cmd) > 0 && cmd[0] == '-' {
			runServe(os.Args[1:])
		} else {
			fmt.Fprintf(os.Stderr, "Unknown command: %s. Run 'meepo --help' for usage.\n", cmd)
			os.Exit(1)
		}
	}
}

func printHelp() {
	fmt.Print(`
Meepo - Multi-Brain Local/Hybrid Agent Orchestration Proxy (Go Edition)

Usage:
  meepo [command] [options]

Commands:
  serve                 Start the OpenAI-compatible reverse proxy (default)
  status                Check health of local sub-brains
  help                  Show this help screen

Options for 'serve':
  --port, -p <number>   Port to listen on (default: 8081)
  --host, -h <string>   Host to bind to (default: 127.0.0.1)
  --config, -c <path>   Path to meepo.config.json
`)
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	port := fs.Int("port", 8081, "Port to listen on")
	fs.IntVar(port, "p", 8081, "Port shorthand")
	host := fs.String("host", "127.0.0.1", "Host to bind to")
	configPath := fs.String("config", "", "Path to config file")
	fs.StringVar(configPath, "c", "", "Config shorthand")

	fs.Parse(args)

	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	addr := fmt.Sprintf("%s:%d", *host, *port)
	srv := proxy.NewServer(cfg)

	fmt.Printf(`
╔═══════════════════════════════════════════════════════════════════╗
║             MEEPO: MULTI-BRAIN LLM PROXY (GOLANG)                ║
║                   OpenAI-Compatible Endpoint                     ║
╚═══════════════════════════════════════════════════════════════════╝

  • Local Endpoint:    http://%s/v1
  • Health Check:      http://%s/health
  • Upstream Llama:    %s
  • Upstream Von:      %s

Available Models:
  - mesh          (Auto-routed Multi-Brain Mesh)
  - chat          (%s - Gemma 4 E2B)
  - tools         (%s - LFM 2.5 1.2B)
  - code          (%s - Qwen 3.5 2B)
  - cloud         (%s - Claude Opus / Gemini)

Pi Configuration (~/.pi/agent/models.json):
  "providers": {
    "meepo": {
      "baseUrl": "http://%s/v1",
      "api": "openai-completions",
      "apiKey": "local"
    }
  }

Press Ctrl+C to stop.
`, addr, addr, cfg.LlamaServer.BaseURL, cfg.Roles.Router.Endpoint,
		cfg.Roles.Chat.ModelID, cfg.Roles.Tools.ModelID, cfg.Roles.Code.ModelID, cfg.Roles.Cloud.ModelID,
		addr)

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigChan
		fmt.Println("\nStopping Meepo proxy...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
		os.Exit(0)
	}()

	if err := srv.Start(addr); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "Server failed: %v\n", err)
		os.Exit(1)
	}
}

func runStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	configPath := fs.String("config", "", "Path to config file")
	fs.Parse(args)

	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	client := &http.Client{Timeout: 1500 * time.Millisecond}

	// Check llama-server
	llamaStatus := "🔴 OFFLINE"
	lResp, err := client.Get(cfg.LlamaServer.BaseURL + "/models")
	if err == nil && lResp.StatusCode == http.StatusOK {
		llamaStatus = "🟢 RUNNING (" + cfg.LlamaServer.BaseURL + ")"
		lResp.Body.Close()
	}

	// Check Von
	vonStatus := "🔴 OFFLINE"
	vResp, err := client.Get(cfg.Roles.Router.Endpoint)
	if err == nil || (vResp != nil && (vResp.StatusCode == 422 || vResp.StatusCode == 404 || vResp.StatusCode == 200)) {
		vonStatus = "🟢 ONLINE (" + cfg.Roles.Router.Endpoint + ")"
		if vResp != nil {
			vResp.Body.Close()
		}
	}

	fmt.Println(`╔════════════════════════════════════════════════════════════════════════════╗
║                      MEEPO: DIVIDED WE STAND (GOLANG)                       ║
║         Multi-Brain Intelligence Mesh (router / chat / tools / code / cloud)║
╚════════════════════════════════════════════════════════════════════════════╝`)
	fmt.Printf("\n  llama-server: %s\n", llamaStatus)
	fmt.Printf("\n  [1. ROUTER]       %s\n     Status: %s\n     Role:   %s\n", cfg.Roles.Router.Name, vonStatus, cfg.Roles.Router.Description)
	fmt.Printf("\n  [2. CHAT]         %s\n     Status: %s\n     Role:   %s\n", cfg.Roles.Chat.Name, llamaStatus, cfg.Roles.Chat.Description)
	fmt.Printf("\n  [3. TOOLS]        %s\n     Status: %s\n     Role:   %s\n", cfg.Roles.Tools.Name, llamaStatus, cfg.Roles.Tools.Description)
	fmt.Printf("\n  [4. CODE]         %s\n     Status: %s\n     Role:   %s\n", cfg.Roles.Code.Name, llamaStatus, cfg.Roles.Code.Description)
	fmt.Printf("\n  [5. CLOUD]        %s\n     Status: 🟢 ONLINE\n     Role:   %s\n", cfg.Roles.Cloud.Name, cfg.Roles.Cloud.Description)
	fmt.Println("══════════════════════════════════════════════════════════════════════════════")
}
