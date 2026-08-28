# Releasing Listen

Listen packages Windows, Linux, and macOS builds with GitHub Actions. Published releases also contain Tauri's signed `latest.json`, which installed copies use for updates.

## One-time GitHub secrets

The updater public key is committed in `src-tauri/tauri.conf.json`. The private key and its password must only exist in the maintainer's secure storage and GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: the complete contents of `listen.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password used when the key was generated

Never commit the private key. Back it up with the password: losing either prevents installed copies from trusting future releases.

These keys sign Tauri updater artifacts. They do not sign the macOS application for Gatekeeper. macOS bundles use the ad-hoc identity configured in `src-tauri/tauri.conf.json`, and the release workflow verifies that the resulting application has a complete bundle signature. Without that explicit identity, cross-target builds can retain only the linker's partial signature, causing downloaded copies to be reported as damaged.

Ad-hoc signing does not establish a verified developer identity or notarize the application. Users may still need to approve the first launch in System Settings. Warning-free distribution requires a Developer ID Application certificate and Apple notarization credentials; when those are available, replace the ad-hoc identity and configure them in the release workflow.

## Publish a release

1. Update the same semantic version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, then refresh both lockfiles.
2. Commit and push the version change.
3. Either run **Release Listen** from GitHub Actions or push a matching version tag such as `v0.2.0`.
4. Wait for all four platform jobs to finish.
5. Verify all four jobs succeed. The macOS jobs run strict bundle-signature validation after packaging.
6. Verify the GitHub Release contains installers, updater signatures, and `latest.json`.

`latest.json` is served from:

```text
https://github.com/vini2003/listen/releases/latest/download/latest.json
```

The app checks after startup. It offers an update and restart, but disables installation while recording.

## Local builds

Create native packages for the current operating system:

```text
npm run build:desktop
```

Create only the unsupported portable/raw executable used during development:

```text
npm run build:portable
```

Updater signing requires `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the environment when producing release artifacts.
