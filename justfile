set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# List the recipes.
default:
    @just --list

# Install the npm dependencies.
install:
    npm install

# Start the app with live reload of the renderer and restart on main/preload changes.
dev:
    npx electron-vite dev --watch

# Build once and run the production build without packaging.
preview:
    npx electron-vite preview

# Check the TypeScript types.
typecheck:
    npx tsc --noEmit -p tsconfig.json

# Build the app into out/.
build: typecheck
    npx electron-vite build

# Package the app as a folder with Tesseract.exe in dist/win-unpacked/.
package: build
    npx electron-builder --win dir

# Package the app as an installer in dist/. It installs for the current user, so it needs no admin rights.
package-installer: build
    npx electron-builder --win nsis

# Package the app as one portable exe in dist/. It unpacks itself to a temp folder at each start, so it starts slower.
package-portable: build
    npx electron-builder --win portable

# Raise the version in package.json. The part is patch, minor or major. The Release workflow makes the release after the merge into main.
bump part:
    npm version {{part}} --no-git-tag-version
