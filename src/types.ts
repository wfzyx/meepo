/**
 * @wfzyx/meepo - Type Definitions
 * Divided We Stand: Multi-Brain Intelligence Mesh
 * Scheme 1: Plain Functional (router, chat, tools, code, cloud)
 */

export type BrainRole = 'router' | 'chat' | 'tools' | 'code' | 'cloud';

export type RoleType = 'system_one' | 'autoregressive' | 'cloud_advisor';

export interface BaseRoleConfig {
  name: string;
  type: RoleType;
  description: string;
  enabled?: boolean;
}

export interface SystemOneRoleConfig extends BaseRoleConfig {
  type: 'system_one';
  endpoint: string;
}

export interface AutoregressiveRoleConfig extends BaseRoleConfig {
  type: 'autoregressive';
  modelId: string;
  contextWindow: number;
  temperature?: number;
  topK?: number;
  repeatPenalty?: number;
}

export interface CloudAdvisorRoleConfig extends BaseRoleConfig {
  type: 'cloud_advisor';
  provider: string;
  modelId: string;
}

export type RoleConfig = SystemOneRoleConfig | AutoregressiveRoleConfig | CloudAdvisorRoleConfig;

export interface LlamaServerConfig {
  baseUrl: string;
  modelsDir: string;
  healthEndpoint: string;
}

export interface PolicyConfig {
  autoPruneTools: boolean;
  codeEngineOffloadThresholdLines: number;
  cloudEscalationTriggers: string[];
}

export interface MeepoConfig {
  name: string;
  version: string;
  description: string;
  llamaServer: LlamaServerConfig;
  roles: {
    router: SystemOneRoleConfig;
    chat: AutoregressiveRoleConfig;
    tools: AutoregressiveRoleConfig;
    code: AutoregressiveRoleConfig;
    cloud: CloudAdvisorRoleConfig;
  };
  policy: PolicyConfig;
}

export interface BrainStatus {
  role: BrainRole;
  name: string;
  type: RoleType;
  online: boolean;
  modelLoaded?: boolean;
  latencyMs?: number;
  details?: string;
}

export interface MeshHealth {
  allHealthy: boolean;
  brains: Record<BrainRole, BrainStatus>;
  loadedLlamaModels: string[];
}

export interface RoutingDecision {
  targetRole: BrainRole;
  confidence: number;
  allowedTools?: string[];
  prunedTools?: string[];
  reason: string;
  latencyMs: number;
  source: 'von' | 'heuristic';
}

export interface CodeGenerationRequest {
  language: string;
  instruction: string;
  existingCode?: string;
  filePath?: string;
}

export interface CodeGenerationResult {
  code: string;
  model: string;
  latencyMs: number;
  tokensGenerated?: number;
}

export interface CloudConsultationRequest {
  goal: string;
  filesInPlay?: string[];
  whatWasTried?: string;
  errorOrObstacle: string;
  constraints?: string[];
}

export interface CloudConsultationResult {
  verdict: string;
  recommendedAction: string;
  architecturalRisks: string[];
  model: string;
  latencyMs: number;
}
