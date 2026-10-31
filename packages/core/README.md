# @hearthlog/core

The platform packages a site needs, as one dependency. It has no code of its own: it pins the platform packages to one
version, so a site lists `@hearthlog/core`, `@hearthlog/tooling`, and its modules, and nothing else of the platform.

A site's generated files import the platform packages by name, so the site hoists them (`publicHoistPattern` in its
`pnpm-workspace.yaml`); that is what lets them resolve without being listed.
