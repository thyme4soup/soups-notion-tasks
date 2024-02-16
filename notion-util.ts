import { requestUrl, TFile, FrontMatterCache } from "obsidian";
import { Client } from "@notionhq/client";
import { markdownToBlocks,  } from "@tryfabric/martian";
import * as yamlFrontMatter from "yaml-front-matter";
import SoupsTasksPlugin from "main";

let NOTION_URL = `https://api.notion.com/v1`
let STATUS_MAPPING: Record<string, string> = {
    "Not started": "open",
    "In progress": "open",
    "Done": "closed"
}
let UPDATE_PAGE_CONTENT = false;

export class NotionUtil {
    plugin: SoupsTasksPlugin;
    notion: Client;
    agent: any;
    constructor(plugin: SoupsTasksPlugin) {
        this.plugin = plugin;
        this.notion = new Client({ auth: plugin.settings.notionApiKey })
    }

    async createTask(file: TFile) {
        // creates a notion page with the files contents,
        // adds the notion id to the page's frontmatter yaml
        const contentBlocks = await this.composePage(file);
        const metadata = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        const body = {
            parent: {database_id: this.plugin.settings.notionTaskDb},
            properties: {
                Name: {title: [{text: {content: file.basename,},},],},
                Tags: {multi_select: [{"name": "michael"}],},
                Status: {"status": {"name": metadata?.tags.contains("open") ? "Not started" : "Done"}}
            }
        }
        const res = await requestUrl({
            url: `${NOTION_URL}/pages`,
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(body)
        });
        const notionId = this.getIdFromUrl(res.json['url']);
        // Add the body separately
        const children = {
            "children": contentBlocks
        }
        const response = await requestUrl({
            url: `${NOTION_URL}/blocks/${notionId}/children`,
            method: 'PATCH',
            headers: this.getHeaders(),
            body: JSON.stringify(children)
        }).catch(e => {
            console.log("Error adding note body, will carry on\n", e)
        });
        return res.json['url'];
    }

    async updateTask(file: TFile, notionId: string) {
        // get page status and update file if applicable
        const page = await requestUrl({
            url: `${NOTION_URL}/pages/${notionId}`,
            method: 'GET',
            headers: this.getHeaders()
        }).catch(async e => {
            console.log(e);
            if (e.message.contains('Request failed, status 404')) {
                // clear link
                this.writeOrUpdateMetadata(file, "link", "");
            }
        });
        if (!page) {
            return;
        }
        const status = page.json['properties']['Status']['status']['name'];
        const title = page.json['properties']['Name']['title'][0]['plain_text'];
        const new_status = this.updateStatus(file, status);
        if (status != new_status || title != file.basename) {
            const res = await requestUrl({
                url: `${NOTION_URL}/pages/${notionId}`,
                method: 'PATCH',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    "properties": {
                        "Status": {
                            "status": {
                                "name": new_status
                            }
                        },
                        "Name": {
                            "title": [
                                {
                                    "type": "text",
                                    "text": {
                                        "content": file.basename
                                    }
                                }
                            ]
                        }
                    }
                })
            });
        }

        if (UPDATE_PAGE_CONTENT) {
            // Clear out the old page
            const resOldChildren = await requestUrl({
                //ToDo: paginate
                url: `${NOTION_URL}/blocks/${notionId}/children?page_size=100`,
                method: 'GET',
                headers: this.getHeaders()
            })
            // we have to do this sequentially or risk 409s
            for (const block of resOldChildren.json['results']) {
                const resp = await requestUrl({
                    url: `${NOTION_URL}/blocks/${block['id']}`,
                    method: 'DELETE',
                    headers: this.getHeaders()
                })
            }
            // Add new content
            const new_kids = await this.composePage(file);
            // ToDo: large blocks get 400
            const body = {
                "children": new_kids
            }
            const response = await requestUrl({
                url: `${NOTION_URL}/blocks/${notionId}/children`,
                method: 'PATCH',
                headers: this.getHeaders(),
                body: JSON.stringify(body)
            })
            return response;
        }
    }

    async composePage(file: TFile) {
        // ToDo: should this use app.metadataCache?
        const markdown = await this.plugin.app.vault.cachedRead(file);
        return markdownToBlocks(yamlFrontMatter.loadFront(markdown).__content);
    }

    async createOrUpdateTask(file: TFile) {
        const metadata = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        if (metadata == undefined || !this.isTask(file)) {
            return;
        }
        
        if (metadata.link) {
            const notionId = this.getIdFromUrl(metadata.link);
            if (notionId == undefined) {
                console.log("Invalid notion link in " + file.path);
                return;
            } else {
                return this.updateTask(file, notionId);
            }
        } else {
            const url = await this.createTask(file);
            this.writeOrUpdateMetadata(file, 'link', url);
        }
    }

    async cleanUpTask(metadata: FrontMatterCache) {
        if (metadata.link != null) {
            const notionId = this.getIdFromUrl(metadata.link);
            if (notionId == undefined) {
                console.log("Couldn't get id, skipping");
                return;
            } else {
                await requestUrl({
                    url: `${NOTION_URL}/blocks/${notionId}`,
                    method: 'DELETE',
                    headers: this.getHeaders()
                })
            }
        }
    }

    getIdFromUrl(url: string) {
        return url.split('/').last()?.split('-').last()
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.plugin.settings.notionApiKey,
            'Notion-Version': '2022-06-28'
        }
    }

    writeOrUpdateMetadata(file: TFile, key: string, value: any) {
        this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
            frontmatter[key] = value
        })
    }

    isTask(file: TFile) {
        const metadata = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        return metadata != undefined && metadata.tags != undefined && metadata.tags.contains("task")
    }

    updateStatus(file: TFile, notion_status: string) {
        const tags = new Set<string>(this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.tags);
        const closed = tags.has('closed');
        tags.delete('open');
        tags.delete('closed');
        const new_status = STATUS_MAPPING[notion_status] == "closed" || closed ? "closed" : "open";
        tags.add(new_status);
        this.writeOrUpdateMetadata(file, 'tags', Array.from(tags));
        return new_status == 'closed' ? "Done" : notion_status
    }
}