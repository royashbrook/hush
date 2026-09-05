# cold adoption fixture

The app needs EXISTING_TOKEN (derive from .dev.vars), SESSION_KEY (mint a random secret), and
USER_TOKEN (ask the user, never invent it). MODE is ordinary configuration, not a secret.
The test supplies an explicitly synthetic user answer only after proving the missing-token stop.

This is a deterministic rehearsal of the documented adoption steps, not an LLM evaluation.
