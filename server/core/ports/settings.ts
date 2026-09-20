/** Settings: the one way anything in this process reads a configuration value. Empty means unset. */
export interface Settings {
  get(name: string): string | undefined;
  /** Throws an Error naming the missing setting. */
  require(name: string): string;
}
