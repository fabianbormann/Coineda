# Listing Coineda on openCode

[openCode](https://opencode.de) is the German federal "Public Money, Public Code" platform. Its GitLab
(gitlab.opencode.de) hosts software that public administration builds, buys or reuses, and its software
directory lists every project whose repository root holds a valid `publiccode.yml`. Coineda's German
report is aimed at the people who look there: tax-administration IT (KONSENS, the Länder) and advisory
firms. Being listed costs little and puts the project in front of them.

The repository is prepared; publishing is the owner's step. Nothing in this repository talks to openCode.

## What the repository already carries

- `publiccode.yml` at the root, written to `publiccodeYmlVersion: "0.4"`, with English and German
  descriptions. `tests/publiccode.test.ts` checks it against the publiccode.yml standard (mandatory keys,
  enumerations, description lengths, existing logo and screenshot, language list, version and licence).
- `.gitlab-ci.yml` at the root, which runs the same five commands as `.github/workflows/test.yml`
  (`npm ci`, lint, format check, typecheck, `npx vitest run`) in a `node:22` image. GitHub ignores it. A
  test keeps the two in step.
- `LICENSE` (GPLv3), `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` and a
  release-please `CHANGELOG.md`.
- `package.json` declares `GPL-3.0-only`, the same licence under its current SPDX identifier.

## Publishing steps

1. Create an account on gitlab.opencode.de, following the openCode guide for new projects.
2. Create a group or use a personal namespace for the project.
3. Create the repository there. Either push a copy by hand, or set up a pull mirror from
   `https://github.com/fabianbormann/Coineda` (Settings, Repository, Mirroring repositories). A mirror
   keeps `publiccode.yml`, the pipeline and the release tags current without further work. If the
   instance does not offer pull mirroring, push to it instead (a push mirror from GitHub, or a manual push
   per release).
4. Change `url:` in `publiccode.yml` to the gitlab.opencode.de repository URL. openCode requires `url` to be
   the repository it reads. Keep `landingURL` (the hosted app) as it is. Commit the change on the
   repository openCode reads; if it is a pull mirror, make the change on GitHub instead.
5. Open the repository in the openCode editor and press "Validate" on `publiccode.yml`. That validator is
   the authority; if it rejects a key, change the file and keep `tests/publiccode.test.ts` in step.
6. Protect `main`: no force-push, merge only through merge requests (Settings, Repository, Protected
   branches).
7. Enable the issue tracker, so reports can be answered within a week.
8. Optional: add a `contacts` entry with an e-mail address under `maintenance` in `publiccode.yml`. The file
   carries only a name today, deliberately.
9. Wait for the directory to pick the project up. Check that the German and English descriptions render.

Not every step has to happen at once; step 4 and 5 are what make the listing appear.

## Badges

The badge criteria below are those published at badges.opencode.de (checked 2026-10-10). "Repository"
means the repository already meets it, "platform" means a setting on gitlab.opencode.de, "owner" means it
depends on how the project is run, and "n/a" means the criterion does not apply to what Coineda ships.

| Badge            | Level | Criterion                                                          | Status                                               |
| ---------------- | ----- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| Open Source      | 1     | Licence on the ZenDiS list                                         | Repository: GPL-3.0-only                             |
| Aktive Wartung   | 1     | At least 5 commits in 6 months                                     | Owner: met by ordinary development                   |
| Aktive Wartung   | 1     | Issue response in under 7 days                                     | Owner, and the issue tracker is a platform setting   |
| Aktive Wartung   | 2     | Level 1 and a release or tag in 6 months                           | Repository: release-please cuts releases and tags    |
| Aktive Wartung   | 3     | Level 2 and several maintainers                                    | Owner: needs more maintainers (community)            |
| Nachnutzung      | 1     | A published package                                                | Owner: installers are on GitHub Releases; check after mirroring whether openCode counts them, else publish a release on gitlab.opencode.de |
| Nachnutzung      | 1     | A successful CI pipeline in 6 months                               | Repository: `.gitlab-ci.yml`; runs once mirrored     |
| Nachnutzung      | 2     | One organisation uses the project                                  | Owner/community                                      |
| Nachnutzung      | 3     | Ten organisations use the project                                  | Owner/community                                      |
| Security         | 1     | `SECURITY.md` at the root                                          | Repository                                           |
| Security         | 1     | Protected default branch, no force-push                            | Platform: step 6 above                               |
| Security         | 1     | Issue response in under 7 days                                     | Owner, with the tracker enabled (step 7)             |
| Security         | 2     | At least 75 % of merge requests reviewed                           | Owner: review habit                                  |
| Security         | 2     | At least 80 % of tags signed                                       | Owner: tags are not signed today                     |
| Security         | 3     | Releases free of CVSS 7 or higher; such CVEs handled within a day  | Owner                                                |
| Lieferketten     | 1     | Changelog                                                          | Repository: `CHANGELOG.md`                           |
| Lieferketten     | 1     | Contribution guidelines                                            | Repository: `CONTRIBUTING.md`                        |
| Lieferketten     | 1     | Container SBOM attestation                                         | n/a: Coineda ships no container image                |
| Lieferketten     | 2, 3  | VEX and provenance attestations for container images               | n/a: Coineda ships no container image                |
| Grundschutz++    |       | Not assessed here                                                  | Owner                                                |

The Electron installers are not signed (see `SECURITY.md`), and there is no SBOM for them. Neither is a
badge criterion for a project without a container image, but both would be reasonable next steps.

## Keeping `publiccode.yml` current

- `softwareVersion` carries a `# x-release-please-version` comment. The release workflow passes
  `extra-files: publiccode.yml` to release-please, so every release pull request bumps the line together
  with `package.json`. `tests/publiccode.test.ts` fails if the two differ or the annotation is lost.
- There is no `releaseDate`: the generic updater cannot maintain it, and a stale date is worse than none.
- When a feature, platform or language is added, change the descriptions and `features` in both languages
  in the same pull request. State only what the code does, and keep the sentence that Coineda aims to be a
  filing aid and gives no tax advice.
- `publiccodeYmlVersion` stays at `0.4`, the newest version every maintained parser accepts. The file uses
  only keys that exist unchanged up to 0.7.0, so moving to a newer version later is a one-line change plus
  a validation on openCode. Check the standard's changelog first: later versions add and deprecate keys.
