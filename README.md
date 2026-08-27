# SpecGuard end-to-end sandbox

This repository exists only to verify the private-beta SpecGuard flow against:

- Jira project `SG`
- Jira issue `SG-4`
- Confluence specification page `262149`

The `main` branch is intentionally compliant: a Country Admin cannot inherit Local permissions.
The end-to-end drift PR uses branch `feature/SG-4-country-admin` and deliberately reverses that
rule so SpecGuard should return `DRIFT` with grounded Jira, Confluence, and code evidence.
