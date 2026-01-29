/**
 * Kiro API 常量配置
 */
export const KIRO_CONSTANTS = {
    // Token 刷新端点
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    REFRESH_SSO_OIDC_URL: 'https://sso-oidc.{{region}}.amazonaws.com/token',

    // API 端点
    BASE_URL: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse',
    AMAZON_Q_URL: 'https://codewhisperer.{{region}}.amazonaws.com/SendMessageStreaming',
    USAGE_LIMITS_URL: 'https://codewhisperer.{{region}}.amazonaws.com/getUsageLimits',
    LIST_MODELS_URL: 'https://codewhisperer.{{region}}.amazonaws.com/ListAvailableModels',

    // 默认配置
    DEFAULT_MODEL_NAME: 'claude-sonnet-4-20250514',
    DEFAULT_REGION: 'us-east-1',
    AXIOS_TIMEOUT: 300000, // 5 分钟超时

    // CodeWhisperer API 实际支持的区域
    CODEWHISPERER_SUPPORTED_REGIONS: [
        'us-east-1'  // 目前只有 us-east-1 确认可用
    ],

    // 区域映射：将所有区域映射到 us-east-1（唯一确认工作的区域）
    REGION_MAPPING: {
        'us-east-1': 'us-east-1',
        'us-west-1': 'us-east-1',  // 映射到 us-east-1
        'us-west-2': 'us-east-1',  // 映射到 us-east-1
        'eu-west-1': 'us-east-1'   // 映射到 us-east-1
    },

    // 请求头
    USER_AGENT: 'KiroIDE',
    KIRO_VERSION: '0.7.5',
    CONTENT_TYPE_JSON: 'application/json',
    ACCEPT_JSON: 'application/json',

    // 认证方式
    AUTH_METHOD_SOCIAL: 'social',
    AUTH_METHOD_BUILDER_ID: 'builder-id',
    AUTH_METHOD_IDC: 'IdC',

    // 请求参数
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
    ORIGIN_AI_EDITOR: 'AI_EDITOR',
};

/**
 * 获取 CodeWhisperer API 支持的区域
 * 如果用户选择的区域不被支持，返回映射的区域
 * @param {string} userRegion - 用户选择的区域
 * @returns {string} CodeWhisperer API 支持的区域
 */
export function getCodeWhispererRegion(userRegion) {
    if (!userRegion) {
        return KIRO_CONSTANTS.DEFAULT_REGION;
    }

    // 如果直接支持，返回原区域
    if (KIRO_CONSTANTS.CODEWHISPERER_SUPPORTED_REGIONS.includes(userRegion)) {
        return userRegion;
    }

    // 使用映射表
    const mappedRegion = KIRO_CONSTANTS.REGION_MAPPING[userRegion];
    if (mappedRegion) {
        console.log(`[REGION] 映射区域: ${userRegion} -> ${mappedRegion}`);
        return mappedRegion;
    }

    // 回退到默认区域
    console.warn(`[REGION] 不支持的区域 ${userRegion}，使用默认区域 ${KIRO_CONSTANTS.DEFAULT_REGION}`);
    return KIRO_CONSTANTS.DEFAULT_REGION;
}

/**
 * 构建 CodeWhisperer API URL
 * @param {string} baseUrl - 基础 URL 模板（包含 {{region}} 占位符）
 * @param {string} userRegion - 用户选择的区域
 * @returns {string} 完整的 API URL
 */
export function buildCodeWhispererUrl(baseUrl, userRegion) {
    const actualRegion = getCodeWhispererRegion(userRegion);
    return baseUrl.replace('{{region}}', actualRegion);
}
export const KIRO_MODELS = [
    'claude-sonnet-4-20250514',
    'claude-sonnet-4-5-20250929',
    'claude-3-7-sonnet-20250219',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5'
];

/**
 * 模型映射表 - 将模型名称映射到 Kiro API 使用的内部名称
 */
export const MODEL_MAPPING = {
    // Sonnet 系列 (与 kiro2api 一致)
    'claude-sonnet-4-5': 'CLAUDE_SONNET_4_5_20250929_V1_0',
    'claude-sonnet-4-5-20250929': 'CLAUDE_SONNET_4_5_20250929_V1_0',
    'claude-sonnet-4-20250514': 'CLAUDE_SONNET_4_20250514_V1_0',
    'claude-3-7-sonnet-20250219': 'CLAUDE_3_7_SONNET_20250219_V1_0',
    // Haiku 系列 (与 kiro2api 一致，使用 auto)
    'claude-3-5-haiku-20241022': 'auto',
    'claude-haiku-4-5-20251001': 'auto',
    'claude-haiku-4-5': 'auto',
    // Opus 系列
    'claude-opus-4-5': 'claude-opus-4.5',
    'claude-opus-4-5-20251101': 'claude-opus-4.5'
};

/**
 * OAuth 配置
 */
export const KIRO_OAUTH_CONFIG = {
    // Kiro Auth Service 端点 (用于 Social Auth) - 支持多区域
    authServiceEndpoint: 'https://prod.{{region}}.auth.desktop.kiro.dev',

    // AWS SSO OIDC 端点 (用于 Builder ID) - 支持多区域
    ssoOIDCEndpoint: 'https://oidc.{{region}}.amazonaws.com',

    // AWS Builder ID 起始 URL
    builderIDStartURL: 'https://view.awsapps.com/start',

    // 本地回调端口范围
    callbackPortStart: 19876,
    callbackPortEnd: 19880,

    // 超时配置
    authTimeout: 10 * 60 * 1000,  // 10 分钟
    pollInterval: 5000,           // 5 秒

    // CodeWhisperer Scopes
    scopes: [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
        'codewhisperer:transformations',
        'codewhisperer:taskassist'
    ],

    // 凭据存储
    credentialsDir: '.kiro',
    credentialsFile: 'oauth_creds.json',

    // 支持的区域列表
    supportedRegions: [
        'us-east-1',
        'us-west-1',
        'us-west-2',
        'eu-west-1'
    ]
};

/**
 * Amazon Bedrock 常量配置
 */
export const BEDROCK_CONSTANTS = {
    // API 端点模板
    RUNTIME_ENDPOINT: 'https://bedrock-runtime.{{region}}.amazonaws.com',
    INVOKE_MODEL_PATH: '/model/{{modelId}}/invoke',
    CONVERSE_PATH: '/model/{{modelId}}/converse',
    CONVERSE_STREAM_PATH: '/model/{{modelId}}/converse-stream',

    // 默认配置
    DEFAULT_REGION: 'us-east-1',
    DEFAULT_MODEL: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    AXIOS_TIMEOUT: 300000, // 5 分钟超时

    // 支持的区域
    SUPPORTED_REGIONS: [
        'us-east-1',
        'us-west-2',
        'eu-west-1',
        'eu-west-3',
        'ap-northeast-1',
        'ap-southeast-2'
    ],

    // 服务名称（用于 AWS Signature）
    SERVICE_NAME: 'bedrock'
};

/**
 * Bedrock Claude 模型映射
 */
export const BEDROCK_MODEL_MAPPING = {
    // Claude 4.5 Opus
    'claude-opus-4-5': 'anthropic.claude-opus-4-5-20251101-v1:0',
    'claude-opus-4-5-20251101': 'anthropic.claude-opus-4-5-20251101-v1:0',
    // Claude Sonnet 4.5
    'claude-sonnet-4-5': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    'claude-sonnet-4-5-20250929': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    // Claude Sonnet 4
    'claude-sonnet-4': 'anthropic.claude-sonnet-4-20250514-v1:0',
    'claude-sonnet-4-20250514': 'anthropic.claude-sonnet-4-20250514-v1:0',
    // Claude 3.7 Sonnet
    'claude-3-7-sonnet': 'anthropic.claude-3-7-sonnet-20250219-v1:0',
    'claude-3-7-sonnet-20250219': 'anthropic.claude-3-7-sonnet-20250219-v1:0',
    // Claude 3.5 Sonnet v2
    'claude-3-5-sonnet-v2': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'claude-3-5-sonnet-20241022': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    // Claude 3.5 Sonnet v1
    'claude-3-5-sonnet': 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    'claude-3-5-sonnet-20240620': 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    // Claude 3.5 Haiku
    'claude-3-5-haiku': 'anthropic.claude-3-5-haiku-20241022-v1:0',
    'claude-3-5-haiku-20241022': 'anthropic.claude-3-5-haiku-20241022-v1:0',
    // Claude 3 Opus
    'claude-3-opus': 'anthropic.claude-3-opus-20240229-v1:0',
    'claude-3-opus-20240229': 'anthropic.claude-3-opus-20240229-v1:0',
    // Claude 3 Sonnet
    'claude-3-sonnet': 'anthropic.claude-3-sonnet-20240229-v1:0',
    'claude-3-sonnet-20240229': 'anthropic.claude-3-sonnet-20240229-v1:0',
    // Claude 3 Haiku
    'claude-3-haiku': 'anthropic.claude-3-haiku-20240307-v1:0',
    'claude-3-haiku-20240307': 'anthropic.claude-3-haiku-20240307-v1:0'
};

/**
 * Bedrock 支持的模型列表
 */
export const BEDROCK_MODELS = [
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20240620',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307'
];

/**
 * 模型定价配置（美元/百万 tokens）
 */
export const MODEL_PRICING = {
    // Claude Opus 4.5
    'claude-opus-4-5-20251101': { input: 15, output: 75 },
    'claude-opus-4.5': { input: 15, output: 75 },

    // Claude Sonnet 4
    'claude-sonnet-4-20250514': { input: 3, output: 15 },
    'CLAUDE_SONNET_4_20250514_V1_0': { input: 3, output: 15 },

    // Claude Sonnet 4.5
    'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
    'CLAUDE_SONNET_4_5_20250929_V1_0': { input: 3, output: 15 },

    // Claude 3.7 Sonnet
    'claude-3-7-sonnet-20250219': { input: 3, output: 15 },
    'CLAUDE_3_7_SONNET_20250219_V1_0': { input: 3, output: 15 },

    // Claude 3.5 Sonnet
    'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
    'claude-3-5-sonnet-20240620': { input: 3, output: 15 },

    // Claude Haiku 4.5
    'claude-haiku-4-5': { input: 0.80, output: 4 },
    'claude-haiku-4.5': { input: 0.80, output: 4 },

    // Claude 3.5 Haiku
    'claude-3-5-haiku-20241022': { input: 0.80, output: 4 },

    // Claude 3 Opus
    'claude-3-opus-20240229': { input: 15, output: 75 },

    // Claude 3 Sonnet
    'claude-3-sonnet-20240229': { input: 3, output: 15 },

    // Claude 3 Haiku
    'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },

    // Gemini 模型定价
    'gemini-2.5-computer-use-preview-10-2025': { input: 1.25, output: 5 },
    'gemini-3-pro-image-preview': { input: 1.25, output: 5 },
    'gemini-3-pro-preview': { input: 1.25, output: 5 },
    'gemini-3-flash-preview': { input: 0.075, output: 0.30 },
    'gemini-2.5-flash-preview': { input: 0.075, output: 0.30 },
    'gemini-claude-sonnet-4-5': { input: 3, output: 15 },
    'gemini-claude-sonnet-4-5-thinking': { input: 3, output: 15 },
    'gemini-claude-opus-4-5-thinking': { input: 15, output: 75 },

    // 默认定价（按 Sonnet 计算）
    'default': { input: 3, output: 15 }
};

// 动态定价缓存（从数据库加载）
let dynamicPricingCache = null;
let dynamicPricingCacheTime = null;
const PRICING_CACHE_TTL = 60000; // 60 秒缓存

/**
 * 设置动态定价缓存
 * @param {object} pricingMap - 定价映射表 { modelName: { input, output } }
 */
export function setDynamicPricing(pricingMap) {
    dynamicPricingCache = pricingMap;
    dynamicPricingCacheTime = Date.now();
}

/**
 * 获取动态定价
 */
export function getDynamicPricing() {
    return dynamicPricingCache;
}

/**
 * 检查动态定价缓存是否有效
 */
export function isDynamicPricingValid() {
    if (!dynamicPricingCache || !dynamicPricingCacheTime) return false;
    return (Date.now() - dynamicPricingCacheTime) < PRICING_CACHE_TTL;
}

/**
 * 计算 Token 费用（美元）
 * @param {string} model - 模型名称
 * @param {number} inputTokens - 输入 token 数
 * @param {number} outputTokens - 输出 token 数
 * @returns {object} { inputCost, outputCost, totalCost }
 */
export function calculateTokenCost(model, inputTokens, outputTokens) {
    // 优先使用动态定价（数据库配置）
    let pricing = null;
    if (dynamicPricingCache && dynamicPricingCache[model]) {
        pricing = dynamicPricingCache[model];
    } else {
        // 回退到静态配置
        pricing = MODEL_PRICING[model] || MODEL_PRICING['default'];
    }
    
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    return {
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost
    };
}
