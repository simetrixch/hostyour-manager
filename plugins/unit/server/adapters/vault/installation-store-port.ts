// A value the installation's own store holds and a consumer's manifest declares as its source
// (`store: { entry, field }`): the installer minted it, and the Manager copies it into the consumer's
// entry instead of asking the operator to type it. The ONE value the Manager reads from Vault outside
// its own credential store, and only where the installation's policy grants that entry.

export interface InstallationStore {
  /** The installation's stage, under which every entry is read (`secret/<stage>/<entry>`). */
  readonly stage: string;
  /** The field's value, or null where the entry or the field does not exist. A refused read throws. */
  readField(entry: string, field: string): Promise<string | null>;
}
