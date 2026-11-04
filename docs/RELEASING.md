# Releasing

Releases are listed in `.github/release-manifest.txt` (`<tag> <commit>` per line). The `release` workflow creates every
missing tag and GitHub release from it, attaching a source zip and the matching CHANGELOG section as notes.

**One-time setup:** GitHub refuses to let the default Actions token create tags on commits that contain workflow files.
Create a personal access token (fine-grained: this repository, Contents read and write, Workflows read and write; or a classic
token with `repo` and `workflow`), and save it as the repository secret `RELEASE_TOKEN`
(Settings, Secrets and variables, Actions). Then run the `release` workflow from the Actions tab.

**Each new milestone:** add a line to the manifest, update `CHANGELOG.md` with a `## [x.y.z]` section, push to `main`.

Without the secret you can still release by hand: Releases, Draft a new release, create the tag on the commit from the manifest.
