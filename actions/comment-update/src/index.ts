import * as fs from 'fs';
import * as core from "@actions/core";
import * as github from "@actions/github";
import nunjucks from "nunjucks";
import {humanReadableDate, humanReadableSize} from "./nunjucks-helpers.js";
import {GitHub} from "@actions/github/lib/utils";

const MARKER = '<!-- KESTRA-ACTIONS-UPDATES -->'

const RESULT_EMOJIS: Record<string, string> = {
    success: '✅',
    failure: '❌',
    warning: '⚠️',
    empty: '⚪',
}

class CommentUpdate {
    private octokit: InstanceType<typeof GitHub>;
    private readonly title: string;
    private readonly titleHash: string;
    private boldTitle: string = '';
    private summarySuffix: string = '';
    private readonly resultTemplate: string;
    private readonly titleSummaryTemplate: string;
    private readonly template: string;
    private readonly fetchArtifact: boolean;
    private readonly addSummary: boolean;
    private readonly files: string[];
    private readonly nunjucks: nunjucks.Environment;
    private readonly owner: string;
    private readonly repo: string;
    private readonly prId: number;
    private readonly fetchUnreleasedCommits: boolean;

    constructor() {
        this.octokit = github.getOctokit(core.getInput('github-token'));
        this.title = core.getInput('title');
        // Hash the raw title only, so the section is still found when result or summary change between runs
        this.titleHash = this._simpleHash(this.title);
        // result and title-summary are rendered against the template data once it's built, so they
        // can reference fetched values (e.g. unreleased commit count) the same way the main template does.
        this.resultTemplate = core.getInput('result');
        this.titleSummaryTemplate = core.getInput('title-summary');
        this.template = core.getInput('template');
        this.fetchArtifact = core.getBooleanInput('fetch-artifact');
        this.addSummary = core.getBooleanInput('add-summary');
        this.files = core.getMultilineInput('files');
        this.fetchUnreleasedCommits = core.getBooleanInput('fetch-unreleased-commits');

        this.nunjucks = new nunjucks.Environment();
        this.nunjucks
            .addFilter('prettyDate', humanReadableDate)
            .addFilter('prettySize', humanReadableSize)

        const ownerOverride = core.getInput('owner');
        const repoOverride = core.getInput('repo');
        const issueOverride = core.getInput('issue-number');
        this.owner = ownerOverride || (github.context.payload.repository?.owner.login as string);
        this.repo = repoOverride || (github.context.payload.repository?.name as string);
        this.prId = issueOverride ? parseInt(issueOverride, 10) : (github.context.payload.pull_request?.number as number);
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
            .map((i: any) => {
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

        if (this.fetchUnreleasedCommits) {
            const unreleased = await this._fetchUnreleasedCommits();
            data["unreleased"] = unreleased;
            core.info(`Included ${unreleased.commits.length} unreleased commits since ${unreleased.latestTag}`);
        }

        data["owner"] = this.owner;
        data["repo"] = this.repo;
        data["github"] = {
            repository: `${this.owner}/${this.repo}`,
        };

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

    _boldTitle(result: string): string {
        let title = this.title;

        if (result) {
            const emoji = RESULT_EMOJIS[result.trim().toLowerCase()];
            if (emoji) {
                title = `${title} ${emoji}`;
            } else {
                core.warning(`Unknown result '${result}', expected one of: ${Object.keys(RESULT_EMOJIS).join(', ')}`);
            }
        }

        return title;
    }

    _summarySuffix(summary: string): string {
        return summary.trim() ? ` (${summary.trim()})` : '';
    }

    _sectionContent(content: string): string {
        // The summary text stays outside <b>, so only the title and result emoji are bold
        let section = `<details>\n<summary><b>${this.boldTitle}</b>${this.summarySuffix}</summary>\n<br>\n\n${content}\n\n</details>\n`

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

        const result = this.resultTemplate ? this.nunjucks.renderString(this.resultTemplate, data).trim() : '';
        this.boldTitle = this._boldTitle(result);
        this.summarySuffix = this._summarySuffix(
            this.titleSummaryTemplate ? this.nunjucks.renderString(this.titleSummaryTemplate, data).trim() : ''
        );

        await this._addComment(renderer);

        if (this.addSummary && renderer.trim() !== '') {
            core.summary.addRaw(this._sectionContent(renderer), true).write();
        }
    }

    async _fetchUnreleasedCommits(): Promise<{ latestTag: string; commits: any[] }> {
        let latestTag: string | null = null;
        try {
            const owner = this.owner;
            const repo = this.repo;

            try {
                const release = await this.octokit.rest.repos.getLatestRelease({ owner, repo });
                latestTag = release.data.tag_name ?? null;
                core.debug(`Latest release tag: ${latestTag}`);
            } catch {
                const tags = await this.octokit.rest.repos.listTags({ owner, repo, per_page: 20 });
                if (tags.data.length > 0) {
                    latestTag = tags.data[0].name ?? null;
                }
            }

            if (!latestTag) {
                core.debug(`No tags or releases found in repository`);
                return { latestTag: "unknown", commits: [] };
            }

            let defaultBranch = "main";
            try {
                const repoInfo = await this.octokit.rest.repos.get({ owner, repo });
                defaultBranch = repoInfo.data.default_branch ?? "main";
            } catch {
                core.debug(`Could not determine default branch, using 'main'`);
            }

            let compare: any | null = null;
            try {
                compare = await this.octokit.rest.repos.compareCommits({
                    owner,
                    repo,
                    base: `refs/tags/${latestTag}`,
                    head: defaultBranch,
                });

                if (!compare?.data?.commits?.length) {
                    compare = await this.octokit.rest.repos.compareCommits({
                        owner,
                        repo,
                        base: latestTag,
                        head: defaultBranch,
                    });
                }
            } catch (e) {
                // try fallback branch if initial compare failed
                if (defaultBranch === 'main') {
                    try {
                        compare = await this.octokit.rest.repos.compareCommits({
                            owner,
                            repo,
                            base: latestTag,
                            head: 'master',
                        });
                    } catch (e2) {
                        return { latestTag: latestTag ?? "unknown", commits: [] };
                    }
                } else {
                    return { latestTag: latestTag ?? "unknown", commits: [] };
                }
            }

            if (!compare?.data?.commits) {
                return { latestTag, commits: [] };
            }

            const commits = compare.data.commits
                .filter((c: any) => {
                    const msg = (c.commit?.message ?? '').trim().toLowerCase();
                    return !(
                        msg.startsWith('chore(version): bump to') ||
                        msg.startsWith('chore(version): update snapshot') ||
                        msg.startsWith('chore(version): update to version')
                    );
                })
                .map((c: any) => ({
                    sha: c.sha,
                    message: c.commit?.message?.split('\n')[0],
                    author: c.commit?.author?.name ?? c.author?.login ?? 'unknown',
                    date: c.commit?.author?.date ?? c.commit?.committer?.date,
                }));

            core.debug(`Found ${commits.length} unreleased commits since ${latestTag}`);

            return { latestTag, commits };
        } catch (e) {
            return { latestTag: latestTag ?? "unknown", commits: [] };
        }
    }
}

try {
    const commentUpdate: CommentUpdate = new CommentUpdate();
    await commentUpdate.run();
} catch (error: any) {
    core.setFailed((error as Error).message);
}
