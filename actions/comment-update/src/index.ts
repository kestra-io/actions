import * as fs from 'fs';
import * as core from "@actions/core";
import * as github from "@actions/github";
import nunjucks from "nunjucks";
import {humanReadableDate, humanReadableSize} from "./nunjucks-helpers.js";
import {GitHub} from "@actions/github/lib/utils.js";

const MARKER = '<!-- KESTRA-ACTIONS-UPDATES -->'

class CommentUpdate {
    private octokit: InstanceType<typeof GitHub>;
    private readonly title: string;
    private readonly titleHash: string;
    private readonly template: string;
    private readonly fetchArtifact: boolean;
    private readonly addSummary: boolean;
    private readonly files: string[];
    private readonly nunjucks: nunjucks.Environment;
    private readonly owner: string;
    private readonly repo: string;
    private readonly prId: number;

    constructor() {
        this.octokit = github.getOctokit(core.getInput('github-token'));
        this.title = core.getInput('title');
        this.titleHash = this._simpleHash(this.title);
        this.template = core.getInput('template');
        this.fetchArtifact = core.getBooleanInput('fetch-artifact');
        this.addSummary = core.getBooleanInput('add-summary');
        this.files = core.getMultilineInput('files');

        this.nunjucks = new nunjucks.Environment();
        this.nunjucks
            .addFilter('prettyDate', humanReadableDate)
            .addFilter('prettySize', humanReadableSize)

        this.owner = github.context.payload.repository?.owner.login as string;
        this.repo = github.context.payload.repository?.name as string;
        this.prId = github.context.payload.pull_request?.number as number;
    }

    async _fetchArtifact(): Promise<any> {
        const result = await this.octokit.rest.actions
            .listWorkflowRunArtifacts({
                owner: this.owner,
                repo: this.repo,
                run_id: github.context.runId
            })

        if (result.data.total_count === 0) {
            core.warning(`No artifacts found`)
        } else {
            core.debug(`Found ${result.data.total_count} artifacts`)
        }

        if (!result?.data?.artifacts) {
            return []
        }

        return result
            .data
            .artifacts
            .map((i) => {
                return ({...i, ...{
                        download_url: 'https://github.com/' + this.owner + '/' + this.repo + '/actions/runs/' + github.context.runId + '/artifacts/' + i.id
                    }});
            });
    }

    async _buildData() {
        let data: Record<any, any> = {...github.context, ...{}}

        if (this.fetchArtifact) {
           data = {...data, ...{artifacts: await this._fetchArtifact()}};
        }

        if (this.files) {
            data["files"] = [];
            for (const [index, file] of this.files.entries()) {
                const current = JSON.parse(fs.readFileSync(file, { encoding: 'utf8', flag: 'r' }));
                data["files"][index] = current;
            }
        }

        core.debug(`Generated data:\n${JSON.stringify(data, undefined, 2)}`);

        return data;
    }

    async _findComment() {
        const comments: any[] = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
            owner: this.owner,
            repo: this.repo,
            issue_number: this.prId
        })

        core.debug(`Found ${comments.length} comments`)

        const filter = comments
            .filter(comment => comment.body.includes(MARKER));

        return filter.length > 0 ? filter[0] : null;
    }

    _simpleHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
        }

        return (hash >>> 0).toString(36).padStart(7, '0');
    };

    _sectionContent(content: string): string {
        let section = `## ${this.title}\n\n${content}\n`

        if (content.trim().length == 0) {
            section = "";
        }

        return `<!-- ${this.titleHash} -->\n${section}<!-- /${this.titleHash} -->`;
    }

    async _addComment(content: string): Promise<void> {
        let comment: any = await this._findComment()

        if (comment === null) {
            core.debug(`Comment not found, creating a new one`)

            comment  = await this.octokit.rest.issues.createComment({
                owner: this.owner,
                repo: this.repo,
                issue_number: this.prId,
                body: `${MARKER}\n${this._sectionContent(content)}`
            });
        } else {
            core.debug(`Comment found, updating it`)

            const regExp = new RegExp(`<!-- ${this.titleHash} -->(.*?)<!-- \\/${this.titleHash} -->`, 'gs')
            let commentContent: string = comment.body.replace(MARKER, '').trim();

            if (commentContent.match(regExp)) {
                core.debug(`Section found, updating it`)

                commentContent = commentContent.replaceAll(regExp, this._sectionContent(content));
            } else {
                core.debug(`Section not found, creating a new one`)

                commentContent = `${commentContent}\n\n${this._sectionContent(content)}`
            }

            comment = await this.octokit.rest.issues.updateComment({
                owner: this.owner,
                repo: this.repo,
                comment_id: comment.id,
                body: `${MARKER}\n${commentContent}`
            });
        }

        core.debug(`Comment added/updated: ${comment.data.html_url}`)

        return comment;
    }

    async _renderTemplate(data: any) {
        const s: string = this.nunjucks.renderString(this.template, data);

        core.debug(`Rendered template :\n${s}`)

        return s
    }

    async run(): Promise<void> {
        const data = await this._buildData();
        const renderer: string = await this._renderTemplate(data);

        await this._addComment(renderer);

        if (this.addSummary && renderer.trim() !== '') {
            let section = `## ${this.title}\n\n${renderer}\n`
            core.summary.addRaw(section, true).write();
        }
    }
}

try {
    const commentUpdate: CommentUpdate = new CommentUpdate();
    await commentUpdate.run();
} catch (error: any) {
    core.setFailed((error as Error).message);
}
