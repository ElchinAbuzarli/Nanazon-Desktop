# Nanazon Share — Build & Distribution

## Prerequisites

- Node.js & npm
- Rust toolchain (`source "$HOME/.cargo/env"`)
- Apple Developer ID certificate: `Developer ID Application: Yusif Eynullabayli (Z5GUVS9458)`

## Development

```bash
cd /Users/yusif/Desktop/Nanazon/Nanazon-Desktop
source "$HOME/.cargo/env"
npx tauri dev
```

## Production Build + Sign + Notarize

### 1. Build

```bash
cd /Users/yusif/Desktop/Nanazon/Nanazon-Desktop
source "$HOME/.cargo/env"
npx tauri build
```

### 2. Sign with entitlements + hardened runtime

```bash
codesign --force --deep --options runtime --timestamp \
  --entitlements src-tauri/entitlements.plist \
  --sign "Developer ID Application: Yusif Eynullabayli (Z5GUVS9458)" \
  "src-tauri/target/release/bundle/macos/Nanazon Share.app"
```

### 3. Create DMG

```bash
TEMP_DIR=$(mktemp -d)
cp -R "src-tauri/target/release/bundle/macos/Nanazon Share.app" "$TEMP_DIR/"
ln -s /Applications "$TEMP_DIR/Applications"
hdiutil create -volname "Nanazon Share" -srcfolder "$TEMP_DIR" -ov -format UDZO ~/Desktop/"Nanazon Share.dmg"
rm -rf "$TEMP_DIR"
```

### 4. Sign DMG

```bash
codesign --force --sign "Developer ID Application: Yusif Eynullabayli (Z5GUVS9458)" ~/Desktop/"Nanazon Share.dmg"
```

### 5. Notarize

```bash
xcrun notarytool submit ~/Desktop/"Nanazon Share.dmg" \
  --apple-id "yusif@eynullabeyli.com" \
  --password "pvzc-zvon-dvhm-gxry" \
  --team-id "Z5GUVS9458" --wait
```

### 6. Staple

```bash
xcrun stapler staple ~/Desktop/"Nanazon Share.dmg"
```

## Output

The final signed + notarized DMG will be at:

```
~/Desktop/Nanazon Share.dmg
```

---

## Windows Production Build (cross-compiled from macOS)

### Prerequisites

```bash
brew install nsis llvm
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
```

### Build

```bash
cd /Users/yusif/Desktop/Nanazon/Nanazon-Desktop
source "$HOME/.cargo/env"
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

### Output

```
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Nanazon Share_x64-setup.exe
```

### Notes

- The Windows installer is unsigned (SmartScreen warning on first run)
- Only NSIS installer is supported when cross-compiling (no MSI)
- Windows code signing requires a separate certificate if needed

---

## General Notes

- macOS app is built for **arm64** (Apple Silicon) only
- The `entitlements.plist` in `src-tauri/` is required for WebKit's JIT to work with hardened runtime
- The Developer ID certificate (Previous Sub-CA) expires **Feb 1, 2027**
- The app-specific password may need to be regenerated if it expires
