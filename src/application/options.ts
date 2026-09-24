export interface EngineOptions {
  path?: string;
  clock?: () => number;
  fault?: (stage: string) => void;
  /** Trusted test seam. Must generate unique IDs across reopens; defaults to UUIDs. */
  idFactory?: () => string;
}
