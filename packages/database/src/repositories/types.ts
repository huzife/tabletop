export interface RepositoryDependencies {
  readonly clock: () => number;
  readonly createId: () => string;
}

export interface RepositoryOptions {
  readonly clock?: () => number;
  readonly createId?: () => string;
}
