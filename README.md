# Uptime monitor

Uptime monitor is a small self-hosted service that checks whether your sites and endpoints are up, records the results, alerts you when something goes down, and shows a public status page.

## Built from a plan

Coding agents are building this repository from a public plan made in Tree-Structured Planning (TSP). Each part of the code matches a node in [the plan](https://treestructuredplanning.com/share/h2WxO0dS3p6bvbd-3eesxRzQ7qVGhXoJzOlxKWonNWI).

## What is built so far

These components have tests:

- YAML configuration loading and validation, with defaults and environment variable substitution.
- Monitor definitions for HTTP, TCP and TLS, and a repository that stores monitors and syncs them with the config file.
- A check runner that calls registered probes, enforces timeouts, and measures latency.
- SQLite migrations and storage for check results and incidents.
- Queries for current monitor status, uptime history, and recent incidents.
- Retention that summarizes daily uptime and latency and prunes old data.
- An incident detector that opens and resolves incidents after configurable numbers of consecutive failures or successes.

The HTTP, TCP and TLS probes, alerts, the scheduler, the REST API, the status page, the command-line tool and the Docker image are planned and not built yet.

## Run the checks

Use Node.js 22 and pnpm.

```sh
pnpm install
pnpm lint
pnpm test
pnpm build
```

## License

[MIT](LICENSE)
