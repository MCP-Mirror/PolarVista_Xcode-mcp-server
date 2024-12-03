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

interface BuildArguments {
    projectPath: string;
    scheme: string;
    configuration?: string;
    destination?: string;
}

function isBuildArguments(args: unknown): args is BuildArguments {
    if (typeof args !== 'object' || args === null) return false;
    const a = args as Partial<BuildArguments>;
    return (
        typeof a.projectPath === 'string' && 
        typeof a.scheme === 'string' && 
        (a.configuration === undefined || typeof a.configuration === 'string') &&
        (a.destination === undefined || typeof a.destination === 'string')
    );
}


class XcodeBuildServer {
    private server: Server;
    private baseDir: string;
    private buildLogsDir: string;
    private latestBuildLog: string | null = null;

    constructor(baseDir: string) {
        if (!baseDir) throw new Error("Base directory is required");
        
        this.baseDir = baseDir;
        this.buildLogsDir = path.join(this.baseDir, 'build-logs');
        
        this.server = new Server(
            { name: "xcode-build-server", version: "0.1.0" },
            { capabilities: { resources: {}, tools: {} } }
        );

        this.setupHandlers();
        this.setupErrorHandling();
    }

    private async initializeAsync(): Promise<void> {
        try {
            await mkdir(this.buildLogsDir, { recursive: true });
            console.error(`Created build logs directory at ${this.buildLogsDir}`);
        } catch (error) {
            console.error(`Failed to create build logs directory: ${error}`);
            throw error;
        }
    }

    private setupErrorHandling(): void {
        this.server.onerror = (error) => console.error("[MCP Error]", error);
        process.on("SIGINT", async () => {
            await this.server.close();
            process.exit(0);
        });
    }

    private setupHandlers(): void {
        this.setupResourceHandlers();
        this.setupToolHandlers();
    }

    private setupResourceHandlers(): void {
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
            } catch (error) {
                throw new McpError(ErrorCode.InternalError, `Failed to read build log: ${error}`);
            }
        });
    }

    private setupToolHandlers(): void {
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
                        }
                    },
                    required: ["projectPath", "scheme"]
                }
            }]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (request.params.name !== "build_project") {
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }

            if (!isBuildArguments(request.params.arguments)) {
                throw new McpError(ErrorCode.InvalidParams, "Invalid build arguments provided");
            }

            const { projectPath, scheme, configuration = "Debug", destination } = request.params.arguments;

            try {
                const result = await this.buildProject(projectPath, scheme, configuration, destination);
                this.latestBuildLog = result.logPath;
                return {
                    content: [{
                        type: "text",
                        text: result.output
                    }],
                    isError: !result.success
                };
            } catch (error) {
                console.error('Build error:', error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                const errorOutput = error instanceof Error && 'stderr' in error
                    ? `${errorMessage}\n${error.stderr}`
                    : errorMessage;

                return {
                    content: [{
                        type: "text",
                        text: `Build failed: ${errorOutput}`
                    }],
                    isError: true
                };
            }
        });
    }

private async buildProject(projectPath: string, scheme: string, configuration: string, destination: string = "platform=iOS Simulator,name=iPhone 15 Pro") {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(this.buildLogsDir, `build-${timestamp}.log`);
    const projectDir = path.dirname(projectPath);
    const reportsPath = path.join(projectDir, 'Build', `Reports-${timestamp}`);
    const xcresultPath = `${reportsPath}.xcresult`;
    
    try {
        await mkdir(path.join(projectDir, 'Build'), { recursive: true });
    } catch (error) {
        console.error(`Failed to prepare build directory: ${error}`);
    }

    const command = `which xcodebuild && xcodebuild -project "${projectPath}" \
        -scheme "${scheme}" \
        -configuration "${configuration}" \
        -destination '${destination}' \
        -resultBundlePath "${reportsPath}" \
        -UseModernBuildSystem=YES \
        -json \
        clean build 2>&1 | tee ${logPath}`;
    
    try {
        const { stdout, stderr } = await execAsync(command, { maxBuffer: 100 * 1024 * 1024 });
        
        try {
            // Parse JSON output if possible
            const jsonOutput = stdout.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    try {
                        return JSON.parse(line);
                    } catch (e) {
                        return line;
                    }
                });
            await writeFile(logPath + '.json', JSON.stringify(jsonOutput, null, 2));
        } catch (parseError) {
            console.error('Failed to parse JSON output:', parseError);
        }

        // Read and format the report if it exists
        if (fs.existsSync(xcresultPath)) {
            const reportOutput = await execAsync(`xcodebuild -formatResultBundle ${xcresultPath} -resultBundlePath ${reportsPath}_formatted.xcresult`);
            await writeFile(path.join(this.buildLogsDir, `report-${timestamp}.txt`), reportOutput.stdout);
        }

        const success = !stdout.includes('** BUILD FAILED **');
        return { success, output: stdout + stderr, logPath };
    } catch (error) {
        console.error('Build error:', error);
        if (error instanceof Error) {
            const execError = error as { stderr?: string };
            const errorOutput = error.message + (execError.stderr ? `\n${execError.stderr}` : '');
            await writeFile(logPath, errorOutput);
            return { success: false, output: errorOutput, logPath };
        }
        throw error;
    }
}

    async run(): Promise<void> {
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