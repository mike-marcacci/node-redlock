# Contributing

This library uses [Docker](https://www.docker.com) to provide a consistent environment for development and testing. The `docker-compose.yml` file handles installation of dependencies, building, and initialization of the redis instances and clusters used in tests.

The "runner" service should be used to execute tests, and will continuously monitor and re-run tests by default.

To get started developing, simply run:

```bash
docker compose up
```

Making changes to source files will trigger rebuilding of the code and rerunning of tests.

To run a one-off command, such as a single test, use:

```bash
docker compose run --rm runner yarn test
```
