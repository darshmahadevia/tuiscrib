# Rely on Neon storage protection

The initial portfolio release uses Neon PostgreSQL and adds neither application-layer or end-to-end encryption nor an application-managed backup workflow. It relies on Neon's mandatory encryption and accepts the Free plan's unavoidable restore history and provider retention, while acknowledging infrastructure access and possible loss beyond Neon's recovery window; production-grade backup requirements must be reconsidered later.
