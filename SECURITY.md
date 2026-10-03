# Security

ST-MQ controls local equipment and stores installation information. Keep private
configuration, tokens, account/device identifiers and household exports out of
issues, pull requests, logs and screenshots. See
[secret handling](docs/secret-handling.md) for storage and repository checks.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** action for this repository when
available. Otherwise contact the [maintainer](https://github.com/hokkanen)
privately using their published contact details before sharing sensitive material.
Do not post credentials, exploitable installation details or household data in a
public issue. Include the affected revision, impact and a minimal reproduction
using synthetic data. No response-time guarantee is currently offered.

## Supported versions and deployment

This is a development prerelease. Fixes target the current development version;
older 0.7.5 runtime installations are not maintained by the CSV import support.
There is no promise of compatibility with earlier development databases or
configuration formats.

Use trusted local networking or an authenticated HTTPS reverse proxy for remote
direct access. Configure the admin/family passwords as described in the
[access policy](docs/configuration.md#admin-and-family-web-access).
Every accepted Home Assistant ingress session has application admin access;
sidebar visibility is not a separate authorization boundary.

A secret removed from the current tree may remain in Git history or another
clone. If exposure is suspected, stop publishing the affected history and follow
the [history-handling policy](AGENTS.md#f8). Never include private evidence in a
public security report.
