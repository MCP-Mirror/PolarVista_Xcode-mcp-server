# Xcode MCP Server

<p align="center">
  <strong>A Model Context Protocol server for building Xcode projects directly from LLM applications</strong>
</p>

The Xcode MCP Server provides a Model Context Protocol interface for building Xcode projects. It enables AI assistants to directly trigger builds, monitor build progress, and access build logs through a standardized interface.

## Features

- Build Xcode projects with custom schemes and configurations
- Stream build logs in real-time
- Access detailed build reports
- JSON-formatted build output
- Automatic build log persistence

## Requirements

- Node.js 16+
- Xcode Command Line Tools
- TypeScript
- MCP-compatible client (e.g., Claude Desktop)

## Installation

```bash
# Clone the repository
git clone [your-repo-url]
cd xcode-mcp-server

# Install dependencies
npm install

# Build the server
npm run build
```

## Usage with Claude Desktop

1. Start the server:
   ```bash
   npm run start /path/to/build/logs/directory
   ```

2. In Claude Desktop settings:
   - Go to "Context Sources"
   - Click "Add New Source"
   - Select "Custom MCP Server"
   - Choose "Standard Input/Output"
   - Enter the path to the server: `node /path/to/xcode-mcp-server/build/index.js /path/to/build/logs/directory`

## Available Tools

### build_project

Builds an Xcode project with specified parameters.

Parameters:
- `projectPath` (required): Path to the .xcodeproj or .xcworkspace
- `scheme` (required): Build scheme name
- `configuration` (optional): Build configuration (Debug/Release, defaults to Debug)
- `destination` (optional): Build destination (defaults to "platform=iOS Simulator,name=iPhone 15 Pro")

Example usage in Claude:
```typescript
build_project({
  projectPath: "/path/to/Project.xcodeproj",
  scheme: "MyApp",
  configuration: "Debug"
})
```

## Build Logs

- Build logs are stored in the specified base directory under `build-logs/`
- Each build creates three log files:
  - Plain text log (`build-[timestamp].log`)
  - JSON-formatted log (`build-[timestamp].log.json`)
  - Xcode report (`report-[timestamp].txt`)
- Latest build log is accessible via the `xcode-build://latest-log` resource