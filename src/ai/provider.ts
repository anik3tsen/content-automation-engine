/**
 * The only contract between the pipeline and a language model.
 * Implement it to connect any model provider. The pipeline never depends on a vendor SDK.
 */
export interface CompletionRequest {
  system: string;
  prompt: string;
}

export interface LanguageModel {
  /** Stable name of the model, stamped on every output for traceability. */
  readonly id: string;
  readonly version: string;
  supportsLocale(locale: string): boolean;
  complete(request: CompletionRequest): Promise<string>;
}
