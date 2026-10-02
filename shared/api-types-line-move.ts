/** GET /api/tenants/:id/line-moves — the engine line a tenant runs and the move to a newer one, read as
 *  tenant-line-move plans it. `line` is null for a tenant without an apps bundle, which runs no line. */
export interface LineMoveView {
  line: string | null;
  /** The move on offer, with the reasons it is refused where it is; null where no newer line is released
   *  at the tenant's stage. */
  offer: {
    line: string;
    fromBundle: string;
    toBundle: string | null;
    part: string | null;
    partTag: string | null;
    builds: string[];
    refusals: string[];
  } | null;
}
