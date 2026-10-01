package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type LlamaServerConfig struct {
	BaseURL  string `json:"baseUrl"`
	ModelDir string `json:"modelDir"`
}

type RouterRoleConfig struct {
	Name        string  `json:"name"`
	Type        string  `json:"type"`
	Endpoint    string  `json:"endpoint"`
	Enabled     bool    `json:"enabled"`
	Description string  `json:"description"`
	Threshold   float64 `json:"threshold"`
}

type ModelRoleConfig struct {
	Name          string  `json:"name"`
	Type          string  `json:"type"`
	ModelID       string  `json:"modelId"`
	ContextWindow int     `json:"contextWindow"`
	Description   string  `json:"description"`
	Temperature   float64 `json:"temperature"`
}

type CloudRoleConfig struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Provider    string `json:"provider"`
	ModelID     string `json:"modelId"`
	Enabled     bool   `json:"enabled"`
	Description string `json:"description"`
}

type RolesConfig struct {
	Router RouterRoleConfig `json:"router"`
	Chat   ModelRoleConfig  `json:"chat"`
	Tools  ModelRoleConfig  `json:"tools"`
	Code   ModelRoleConfig  `json:"code"`
	Cloud  CloudRoleConfig  `json:"cloud"`
}

type PolicyConfig struct {
	AutoPruneTools                  bool     `json:"autoPruneTools"`
	CodeEngineOffloadThresholdLines int      `json:"codeEngineOffloadThresholdLines"`
	CloudEscalationTriggers         []string `json:"cloudEscalationTriggers"`
	WarmupPrefill                   bool     `json:"warmupPrefill"`
}

type Config struct {
	Name        string            `json:"name"`
	Version     string            `json:"version"`
	LlamaServer LlamaServerConfig `json:"llamaServer"`
	Roles       RolesConfig       `json:"roles"`
	Policy      PolicyConfig      `json:"policy"`
}

func DefaultConfig() *Config {
	return &Config{
		Name:    "meepo",
		Version: "0.1.0",
		LlamaServer: LlamaServerConfig{
			BaseURL:  "http://127.0.0.1:8080/v1",
			ModelDir: "~/models",
		},
		Roles: RolesConfig{
			Router: RouterRoleConfig{
				Name:        "von-1.3.5",
				Type:        "system_one",
				Endpoint:    "http://127.0.0.1:8000/v1/systemone",
				Enabled:     true,
				Description: "Non-autoregressive OptionMarker System One model (v1.3.5) for sub-30ms intent routing and tool schema pruning",
				Threshold:   0.65,
			},
			Chat: ModelRoleConfig{
				Name:          "gemma-4-E2B-it",
				Type:          "autoregressive",
				ModelID:       "gemma-4-E2B-it",
				ContextWindow: 131072,
				Description:   "Conversational layer with 128k context, user dialogue, and human-facing synthesis",
				Temperature:   0.7,
			},
			Tools: ModelRoleConfig{
				Name:          "LFM2.5-1.2B-Instruct",
				Type:          "autoregressive",
				ModelID:       "LFM2.5-1.2B-Instruct",
				ContextWindow: 32768,
				Description:   "Operational engine with short 1D convolutions for fast tool execution and agent harness steering",
				Temperature:   0.1,
			},
			Code: ModelRoleConfig{
				Name:          "Qwen3.5-2B",
				Type:          "autoregressive",
				ModelID:       "Qwen3.5-2B",
				ContextWindow: 32768,
				Description:   "Specialized syntax, AST, and diff generation engine using Gated Delta Networks",
				Temperature:   0.2,
			},
			Cloud: CloudRoleConfig{
				Name:        "claude-opus-5-5",
				Type:        "cloud_advisor",
				Provider:    "anthropic",
				ModelID:     "anthropic/claude-opus-5-5",
				Enabled:     true,
				Description: "External non-local model for hard architectural decisions, race conditions, and escalation",
			},
		},
		Policy: PolicyConfig{
			AutoPruneTools:                  true,
			CodeEngineOffloadThresholdLines: 5,
			CloudEscalationTriggers: []string{
				"concurrency_race",
				"deadlock",
				"memory_leak",
				"security_boundary",
				"repeated_error",
				"stated_uncertainty",
			},
			WarmupPrefill: true,
		},
	}
}

func LoadConfig(customPath string) (*Config, error) {
	targetPath := customPath
	if targetPath == "" {
		targetPath = os.Getenv("MEEPO_CONFIG_PATH")
	}
	if targetPath == "" {
		// check cwd and executable dir
		candidates := []string{
			".pi/meepo.json",
			"meepo.config.json",
			"../meepo.config.json",
		}
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			candidates = append(candidates, filepath.Join(home, ".pi", "agent", "meepo.json"))
		}
		if exe, err := os.Executable(); err == nil {
			candidates = append(candidates, filepath.Join(filepath.Dir(exe), "meepo.config.json"))
			candidates = append(candidates, filepath.Join(filepath.Dir(exe), "../meepo.config.json"))
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				targetPath = c
				break
			}
		}
	}

	if targetPath == "" {
		return DefaultConfig(), nil
	}

	data, err := os.ReadFile(targetPath)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", targetPath, err)
	}

	cfg := DefaultConfig()
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config %s: %w", targetPath, err)
	}

	if val := os.Getenv("MEEPO_WARMUP_PREFILL"); val != "" {
		cfg.Policy.WarmupPrefill = (val == "1" || val == "true")
	}

	return cfg, nil
}
