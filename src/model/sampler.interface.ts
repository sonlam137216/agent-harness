import type { ModelRequest, ModelResponse, SamplingOptions } from './sampling-types.js';

export interface Sampler {
  sample(request: ModelRequest, options?: SamplingOptions): Promise<ModelResponse>;
}
