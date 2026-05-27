/**
 * Thin OpenRouter client.
 *
 * - One API key (user-supplied, stored in OS Keychain via @hermes/storage).
 * - Switches models by passing a model string ("anthropic/claude-3.5-sonnet",
 *   "openai/gpt-4o", "google/gemini-2.5-flash", "x-ai/grok-...").
 * - Function calling via OpenAI-compatible `tools` API (OpenRouter normalizes).
 * - Vision via multimodal `image_url` content blocks.
 * - Streaming via SSE.
 *
 * Cost is reported by OpenRouter in the response `usage` block; we surface it
 * via the optional `onUsage` callback so the dashboard can aggregate.
 */

export interface OpenRouterClientOptions {
  apiKey: string;
  appUrl?: string;
  appName?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  defaultModel?: string;
  /** Called after every non-streaming completion to record usage. */
  onUsage?: (info: UsageInfo) => void;
}

export interface UsageInfo {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalCost?: number;
  durationMs: number;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object' | { type: 'json_schema'; json_schema: unknown };
  stream?: false;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  total_cost?: number;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly defaultModel: string;
  private readonly headers: Record<string, string>;
  private readonly onUsage?: (info: UsageInfo) => void;

  constructor(opts: OpenRouterClientOptions) {
    if (!opts.apiKey) throw new Error('OpenRouterClient: apiKey is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.fetchFn = opts.fetch ?? fetch;
    this.defaultModel = opts.defaultModel ?? 'google/gemini-2.5-flash';
    this.onUsage = opts.onUsage;
    this.headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (opts.appUrl) this.headers['HTTP-Referer'] = opts.appUrl;
    if (opts.appName) this.headers['X-Title'] = opts.appName;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const start = Date.now();
    const body = {
      model: req.model ?? this.defaultModel,
      messages: req.messages,
      tools: req.tools,
      tool_choice: req.tool_choice,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      response_format: this.formatResponse(req.responseFormat),
    };
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(stripUndefined(body)),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new OpenRouterError(`OpenRouter ${res.status}: ${text}`, res.status, text);
    }
    const json = (await res.json()) as ChatResponse;
    const duration = Date.now() - start;
    if (json.usage && this.onUsage) {
      this.onUsage({
        model: json.model,
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
        totalCost: json.total_cost,
        durationMs: duration,
      });
    }
    return json;
  }

  private formatResponse(
    fmt: ChatRequest['responseFormat'],
  ): Record<string, unknown> | undefined {
    if (!fmt) return undefined;
    if (fmt === 'text') return { type: 'text' };
    if (fmt === 'json_object') return { type: 'json_object' };
    return fmt as Record<string, unknown>;
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
