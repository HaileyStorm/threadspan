# Copy review

Copy review is an optional Threadspan component available to every installation. It is not tied to an owner account, donation, provider tier, or host app.

The collapsed HUD panel can:

- score basic readability locally;
- flag filler, stock phrasing, long sentences, repeated openings, and avoidable passive voice;
- protect URLs, code, quoted text, numbers, mentions, addresses, and selected Voice constraints;
- optionally ask a configured provider for a bounded rewrite;
- return a preview and digest without applying it.

External detector checks are a separate policy. See [External copy check](COPY-CHECK.md). Copy review does not send text to Sapling, Winston, Pangram, GPTZero, or Copyleaks. Threadspan does not market either feature as a way to defeat detection. The useful goal is clearer, more natural copy that preserves meaning.

The component is unchecked by default during setup. Local heuristics make no model call. Provider rewriting is a separate setting that names the provider and model; enabling the component does not sign in, create credentials, select a paid route, or send text anywhere by itself.

The HTTP surface is local-owner authenticated because it carries user text. In a normal single-user installation, that means the person running that Threadspan daemon. It is not an account-plan restriction.
