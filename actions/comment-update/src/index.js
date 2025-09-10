import * as core from "@actions/core";
import * as github from "@actions/github";
import handlebars from "handlebars";
import {fromJson, humanReadableDate, humanReadableSize, toJson} from "./handlebar-helpers.js";

const MARKER = '<!-- KESTRA-ACTIONS-UPDATES -->'

class CommentUpdate {
    constructor(githubToken, title, template) {
        this.octokit = github.getOctokit(core.getInput('github-token'));
        this.title = core.getInput('title');
        this.template = core.getInput('template');

        this.handlebarsInstance = handlebars.create()
        this.handlebarsInstance.registerHelper('prettyDate', humanReadableDate)
        this.handlebarsInstance.registerHelper('prettySize', humanReadableSize)
        this.handlebarsInstance.registerHelper('fromJson', fromJson)
        this.handlebarsInstance.registerHelper('toJson', toJson)

        this.owner = github.context.payload.repository.owner.login;
        this.repo = github.context.payload.repository.name;
        this.prId = github.context.payload.pull_request?.number;
    }

    async fetchArtifact() {
        const result = await this.octokit.rest.actions
            .listWorkflowRunArtifacts({
                owner: this.owner,
                repo: this.repo,
                run_id: github.context.runId
            })

        core.state
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
        const data = {
            ...github.context,
            ...{
                artifacts: await this.fetchArtifact()
            }};

        core.debug(`Generated data:\n${JSON.stringify(data, undefined, 2)}`);

        return data;
    }

    async _findComment() {
        const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
            owner: this.owner,
            repo: this.repo,
            issue_number: this.prId
        })

        core.debug(`Found ${comments.length} comments`)

        const filter = comments
            .filter(comment => comment.body.includes(MARKER));

        return filter.length > 0 ? filter[0] : null;
    }

    async _addComment(content) {
        let comment = await this._findComment()

        if (comment === null) {
            core.debug(`Comment not found, creating a new one`)

            comment = await this.octokit.rest.issues.createComment({
                owner: this.owner,
                repo: this.repo,
                issue_number: this.prId,
                body: `${MARKER}\n${content}`
            });
        } else {
            core.debug(`Comment found, updating it`)

            comment = await this.octokit.rest.issues.updateComment({
                owner: this.owner,
                repo: this.repo,
                comment_id: comment.id,
                body: `${MARKER}\n${content}`
            });

        }

        core.debug(`Comment added/updated: ${comment.data.html_url}`)

        return comment;
    }

    async _renderTemplate(data) {
        const compile = this.handlebarsInstance.compile(this.template);

        const s = compile(data);

        core.debug(`Rendered template :\n${s}`)

        return s
    }

    async run() {
        // // `who-to-greet` input defined in action metadata file
        // const nameToGreet = core.getInput("who-to-greet");
        // core.info(`Hello ${nameToGreet}!`);
        //
        // // Get the current time and set it as an output variable
        // const time = new Date().toTimeString();
        // core.setOutput("time", time);
        //
        //

        const data = await this._buildData();
        const renderer = await this._renderTemplate(data);

        await this._addComment(renderer);
    }
}

try {
    let githubToken = core.getInput('github-token');
    let title = core.getInput('title');
    let template = core.getInput('template');

    const commentUpdate = new CommentUpdate(githubToken, title, template);
    await commentUpdate.run();
} catch (error) {
    core.setFailed(error.message);
}
