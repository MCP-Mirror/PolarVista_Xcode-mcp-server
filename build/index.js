import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
const execAsync = promisify(exec);
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
function isBuildArguments(args) {
    if (typeof args !== 'object' || args === null)
        return false;
    const a = args;
    return (typeof a.projectPath === 'string' &&
        typeof a.scheme === 'string' &&
        (a.configuration === undefined || typeof a.configuration === 'string') &&
        (a.destination === undefined || typeof a.destination === 'string'));
}
// Add these type guard functions
function isBuildOptions(args) {
    if (!isBuildArguments(args))
        return false;
    const a = args;
    return a.includeWarnings === undefined || typeof a.includeWarnings === 'boolean';
}
function isTestOptions(args) {
    if (!isTestArguments(args))
        return false;
    const a = args;
    return a.includeWarnings === undefined || typeof a.includeWarnings === 'boolean';
}
function isTestArguments(args) {
    if (typeof args !== 'object' || args === null)
        return false;
    const a = args;
    return (typeof a.projectPath === 'string' &&
        typeof a.scheme === 'string' &&
        (a.testIdentifier === undefined || typeof a.testIdentifier === 'string') &&
        (a.skipTests === undefined || (Array.isArray(a.skipTests) && a.skipTests.every(t => typeof t === 'string'))) &&
        (a.configuration === undefined || typeof a.configuration === 'string') &&
        (a.destination === undefined || typeof a.destination === 'string'));
}
class XcodeBuildServer {
    constructor(baseDir) {
        this.latestBuildLog = null;
        if (!baseDir)
            throw new Error("Base directory is required");
        this.baseDir = baseDir;
        this.buildLogsDir = path.join(this.baseDir, 'build-logs');
        this.server = new Server({ name: "xcode-build-server", version: "0.1.0" }, { capabilities: { resources: {}, tools: {} } });
        this.setupHandlers();
        this.setupErrorHandling();
    }
    async initializeAsync() {
        try {
            await mkdir(this.buildLogsDir, { recursive: true });
            console.error(`Created build logs directory at ${this.buildLogsDir}`);
        }
        catch (error) {
            console.error(`Failed to create build logs directory: ${error}`);
            throw error;
        }
    }
    setupErrorHandling() {
        this.server.onerror = (error) => console.error("[MCP Error]", error);
        process.on("SIGINT", async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    setupHandlers() {
        this.setupResourceHandlers();
        this.setupToolHandlers();
    }
    // Add this helper function in the XcodeBuildServer class
    filterBuildOutput(jsonOutput) {
        const significantErrors = jsonOutput.filter(line => {
            if (typeof line === 'string') {
                // Include build system lines
                if (line.startsWith('/usr/bin/xcodebuild') ||
                    line.includes('** BUILD')) {
                    return true;
                }
                // Include only actual error messages and their notes
                if (line.match(/^\/.+:\d+:\d+: error:/) || // Matches error lines with file paths
                    line.includes('note: found this candidate')) {
                    return true;
                }
                return false;
            }
            if (typeof line === 'object' && line?.type === 'diagnostic') {
                return line.diagnostic?.severity === 'error';
            }
            return false;
        });
        return significantErrors;
    }
    async runTests(projectPath, scheme, configuration = "Debug", testIdentifier, skipTests, destination = "platform=iOS Simulator,name=iPhone 15 Pro") {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logPath = path.join(this.buildLogsDir, `test-${timestamp}.log`);
        const projectDir = path.dirname(projectPath);
        const reportsPath = path.join(projectDir, 'TestReports', `Reports-${timestamp}`);
        const xcresultPath = `${reportsPath}.xcresult`;
        try {
            await mkdir(path.join(projectDir, 'TestReports'), { recursive: true });
        }
        catch (error) {
            console.error(`Failed to prepare test reports directory: ${error}`);
        }
        let testFlags = 'test';
        if (testIdentifier) {
            testFlags += ` -only-testing:${testIdentifier}`;
        }
        if (skipTests?.length) {
            testFlags += ` ${skipTests.map(test => `-skip-testing:${test}`).join(' ')}`;
        }
        const command = `which xcodebuild && xcodebuild -project "${projectPath}" \
        -scheme "${scheme}" \
        -configuration "${configuration}" \
        -destination '${destination}' \
        -resultBundlePath "${xcresultPath}" \
        -enableCodeCoverage YES \
        -UseModernBuildSystem=YES \
        -json \
        clean ${testFlags} 2>&1 | tee ${logPath}`;
        try {
            const { stdout, stderr } = await execAsync(command, { maxBuffer: 100 * 1024 * 1024 });
            try {
                const jsonOutput = stdout.split('\n')
                    .filter(line => line.trim())
                    .map(line => {
                    try {
                        return JSON.parse(line);
                    }
                    catch (e) {
                        return line;
                    }
                });
                await writeFile(logPath + '.json', JSON.stringify(jsonOutput, null, 2));
            }
            catch (parseError) {
                console.error('Failed to parse JSON output:', parseError);
            }
            // Process test results using xcresulttool
            if (fs.existsSync(xcresultPath)) {
                try {
                    // Get test summary
                    const summaryCmd = `xcrun xcresulttool get --format json --path "${xcresultPath}"`;
                    const { stdout: summaryOutput } = await execAsync(summaryCmd);
                    await writeFile(path.join(this.buildLogsDir, `test-summary-${timestamp}.json`), summaryOutput);
                    // Get code coverage if available
                    const coverageOutput = await execAsync(`xcrun xccov view --report "${xcresultPath}"`);
                    await writeFile(path.join(this.buildLogsDir, `coverage-${timestamp}.txt`), coverageOutput.stdout);
                }
                catch (resultsError) {
                    console.error('Failed to process test results:', resultsError);
                }
            }
            const success = !stdout.includes('** TEST FAILED **') && !stdout.includes('** BUILD FAILED **');
            return { success, output: stdout + stderr, logPath };
        }
        catch (error) {
            console.error('Test error:', error);
            if (error instanceof Error) {
                const execError = error;
                const errorOutput = error.message + (execError.stderr ? `\n${execError.stderr}` : '');
                await writeFile(logPath, errorOutput);
                return { success: false, output: errorOutput, logPath };
            }
            throw error;
        }
    }
    setupResourceHandlers() {
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: this.latestBuildLog ? [{
                    uri: `xcode-build://latest-log`,
                    name: `Latest Xcode Build Log`,
                    mimeType: "text/plain",
                    description: "Most recent Xcode build output"
                }] : []
        }));
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            if (request.params.uri !== 'xcode-build://latest-log' || !this.latestBuildLog) {
                throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${request.params.uri}`);
            }
            try {
                const logContent = await readFile(this.latestBuildLog, 'utf-8');
                return {
                    contents: [{
                            uri: request.params.uri,
                            mimeType: "text/plain",
                            text: logContent
                        }]
                };
            }
            catch (error) {
                throw new McpError(ErrorCode.InternalError, `Failed to read build log: ${error}`);
            }
        });
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{
                    name: "build_project",
                    description: "Build an Xcode project",
                    inputSchema: {
                        type: "object",
                        properties: {
                            projectPath: {
                                type: "string",
                                description: "Path to the .xcodeproj or .xcworkspace"
                            },
                            scheme: {
                                type: "string",
                                description: "Build scheme name"
                            },
                            configuration: {
                                type: "string",
                                description: "Build configuration (e.g., Debug, Release)",
                                default: "Debug"
                            },
                            includeWarnings: {
                                type: "boolean",
                                description: "Include warning messages in output",
                                default: false
                            }
                        },
                        required: ["projectPath", "scheme"]
                    }
                },
                {
                    name: "run_tests",
                    description: "Run Xcode project tests with optional filtering",
                    inputSchema: {
                        type: "object",
                        properties: {
                            projectPath: {
                                type: "string",
                                description: "Path to the .xcodeproj or .xcworkspace"
                            },
                            scheme: {
                                type: "string",
                                description: "Test scheme name"
                            },
                            testIdentifier: {
                                type: "string",
                                description: "Optional specific test to run (e.g., 'MyTests/testExample')"
                            },
                            skipTests: {
                                type: "array",
                                items: { type: "string" },
                                description: "Optional array of test identifiers to skip"
                            },
                            configuration: {
                                type: "string",
                                description: "Build configuration (e.g., Debug, Release)",
                                default: "Debug"
                            }
                        },
                        required: ["projectPath", "scheme"]
                    }
                }]
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            switch (request.params.name) {
                case "build_project": {
                    if (!isBuildOptions(request.params.arguments)) {
                        throw new McpError(ErrorCode.InvalidParams, "Invalid build arguments provided");
                    }
                    const { projectPath, scheme, configuration = "Debug", destination, includeWarnings = false } = request.params.arguments;
                    const result = await this.buildProject(projectPath, scheme, configuration, destination, includeWarnings);
                    this.latestBuildLog = result.logPath;
                    return {
                        content: [{
                                type: "text",
                                text: result.output
                            }],
                        isError: !result.success
                    };
                }
                case "run_tests": {
                    if (!isTestArguments(request.params.arguments)) {
                        throw new McpError(ErrorCode.InvalidParams, "Invalid test arguments provided");
                    }
                    const result = await this.runTests(request.params.arguments.projectPath, request.params.arguments.scheme, request.params.arguments.configuration, request.params.arguments.testIdentifier, request.params.arguments.skipTests, request.params.arguments.destination);
                    this.latestBuildLog = result.logPath;
                    return {
                        content: [{
                                type: "text",
                                text: result.output
                            }],
                        isError: !result.success
                    };
                }
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
        });
    }
    async buildProject(projectPath, scheme, configuration, destination = "platform=iOS Simulator,name=iPhone 15 Pro", includeWarnings = false) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logPath = path.join(this.buildLogsDir, `build-${timestamp}.log`);
        const projectDir = path.dirname(projectPath);
        const reportsPath = path.join(projectDir, 'Build', `Reports-${timestamp}`);
        const xcresultPath = `${reportsPath}.xcresult`;
        try {
            await mkdir(path.join(projectDir, 'Build'), { recursive: true });
        }
        catch (error) {
            console.error(`Failed to prepare build directory: ${error}`);
        }
        const command = `which xcodebuild && xcodebuild -project "${projectPath}" \
        -scheme "${scheme}" \
        -configuration "${configuration}" \
        -destination '${destination}' \
        -resultBundlePath "${xcresultPath}" \
        -UseModernBuildSystem=YES \
        -json \
        clean build 2>&1 | tee ${logPath}`;
        try {
            const { stdout, stderr } = await execAsync(command, { maxBuffer: 100 * 1024 * 1024 });
            try {
                const jsonOutput = stdout.split('\n')
                    .filter(line => line.trim())
                    .map(line => {
                    try {
                        return JSON.parse(line);
                    }
                    catch (e) {
                        return line;
                    }
                });
                // Filter warnings if needed
                const filteredOutput = includeWarnings ? jsonOutput : this.filterBuildOutput(jsonOutput);
                await writeFile(logPath + '.json', JSON.stringify(filteredOutput, null, 2));
                // Use filtered output for response
                const outputText = filteredOutput
                    .map(line => typeof line === 'string' ? line : JSON.stringify(line))
                    .join('\n');
                // Process xcresult if it exists
                if (fs.existsSync(xcresultPath)) {
                    try {
                        const reportOutput = await execAsync(`xcrun xcresulttool get --format json --path "${xcresultPath}"`);
                        await writeFile(path.join(this.buildLogsDir, `report-${timestamp}.json`), reportOutput.stdout);
                        const summaryOutput = await execAsync(`xcrun xcresulttool get --format human-readable --path "${xcresultPath}"`);
                        await writeFile(path.join(this.buildLogsDir, `report-${timestamp}.txt`), summaryOutput.stdout);
                    }
                    catch (reportError) {
                        console.error('Failed to process build results:', reportError);
                    }
                }
                const success = !stdout.includes('** BUILD FAILED **');
                return { success, output: outputText, logPath };
            }
            catch (parseError) {
                console.error('Failed to parse JSON output:', parseError);
                return { success: false, output: stdout + stderr, logPath };
            }
        }
        catch (error) {
            console.error('Build error:', error);
            if (error instanceof Error) {
                const execError = error;
                const errorOutput = error.message + (execError.stderr ? `\n${execError.stderr}` : '');
                await writeFile(logPath, errorOutput);
                return { success: false, output: errorOutput, logPath };
            }
            throw error;
        }
    }
    async run() {
        await this.initializeAsync();
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Xcode Build MCP server running on stdio");
        console.error(`Build logs will be stored in ${this.buildLogsDir}`);
    }
}
const baseDir = process.argv[2];
if (!baseDir) {
    console.error("Base directory argument is required");
    process.exit(1);
}
const server = new XcodeBuildServer(baseDir);
server.run().catch(console.error);
