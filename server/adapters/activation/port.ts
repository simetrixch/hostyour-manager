// The post-onboard Activation port. The onboard `activate` step calls a
// consumer's manifest-declared endpoint over its OWN public ingress once the app is serving — e.g.
// example-auth's first-admin bootstrap. Kept a PORT (types only) so the domain step depends on the
// abstraction; the concrete fetch impl lives in activation-http.ts, the fake in testing/.
//
// SECURITY: the token is the seeded bootstrap secret, kept in-run memory and passed here per call —
// it is never persisted and never logged (the impl sends it as a header value only). The response
// body may carry a root-admin credential (activate_url); the step surfaces it in one operator-facing
// line and this port never stores it.

export interface ActivationRequest {
  /** The full URL: https://<consumer's public host><manifest.activation.path>. */
  url: string;
  method: "POST";
  /** The header the token is sent under, e.g. "X-Bootstrap-Token". */
  tokenHeader: string;
  /** The auth token value (in-run memory; sent as a header, never logged). */
  token: string;
  /** The operator-supplied dynamic args, sent as the JSON body (e.g. { email }). */
  body: Record<string, string>;
  signal?: AbortSignal;
}

export interface ActivationResponse {
  status: number;
  /** true iff a 2xx. A non-2xx makes the onboard `activate` step fail loud. */
  ok: boolean;
  /** The parsed JSON body when the response was JSON (else null) — the step reads `activate_url` and the
   *  OPTIONAL `mail` outcome (ConsumerActivationMailSchema) out of it; both absent = handled as
   *  before. Kept `unknown` so the adapter passes the body through verbatim and the step interprets it. */
  json: unknown;
  /** The raw body text (impl-truncated), used verbatim in the loud failure message on a non-2xx. */
  bodyText: string;
}

export interface Activator {
  /** Make the declared call. A transport error (DNS/TLS/timeout) rejects; an HTTP response — including
   *  a non-2xx — resolves so the step can render the status + body in its failure message. */
  invoke(input: ActivationRequest): Promise<ActivationResponse>;
}
