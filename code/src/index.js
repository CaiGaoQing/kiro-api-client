/**
 * Kiro API Client
 * 通过 AWS CodeWhisperer 访问 Claude 模型
 */

export { KiroClient } from './kiro/client.js';
export { KiroAuth } from './kiro/auth.js';
export { KiroAPI } from './kiro/api.js';
export { KIRO_CONSTANTS, KIRO_MODELS, MODEL_MAPPING, KIRO_OAUTH_CONFIG } from './constants.js';

// Vertex AI 支持
export { VertexClient, VertexAPI, VERTEX_MODEL_MAPPING, VERTEX_REGIONS, VERTEX_DEFAULT_MODEL } from './vertex/vertex.js';

// 默认导出客户端
import { KiroClient } from './kiro/client.js';
export default KiroClient;
