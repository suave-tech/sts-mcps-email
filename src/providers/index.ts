import { GmailProvider } from "./gmail.js";
import { OutlookProvider } from "./outlook.js";
import type { EmailProvider, Provider } from "./types.js";

// Gmail is the only fully-wired provider today. The Outlook adapter exists
// (auth + fetch path compiles) but its OAuth routes aren't implemented —
// see the TODO in src/routes/oauth.ts. IMAP is not started.
//
// This factory is intentionally a switch, not a registry: new providers
// require a routes/OAuth entry anyway, so pretending there's a plugin
// system would be dishonest. If/when Outlook lands, drop it into the
// switch alongside gmail — the orchestrator in src/ingestion/sync.ts
// already treats every provider uniformly through EmailProvider.
export function providerFor(p: Provider): EmailProvider {
  switch (p) {
    case "gmail":
      return GmailProvider;
    case "outlook":
      return OutlookProvider;
    case "imap":
      throw new Error("imap provider not yet implemented — see CONTRIBUTING.md");
  }
}
