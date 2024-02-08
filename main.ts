import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { NotionUtil } from 'notion-util';

interface PluginSettings {
	notionApiKey: string;
	notionTaskDb: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	notionApiKey: 'apiKey',
	notionTaskDb: 'tableId'
}

export default class SoupsTasksPlugin extends Plugin {
	settings: PluginSettings;
	notionUtil: NotionUtil;

	async onload() {
		await this.loadSettings();
		this.notionUtil = new NotionUtil(this);

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('arrow-up-from-line', 'Update task', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('Uploading task!');
			// get current file n stuff
			const currentFile = this.app.workspace.getActiveFile()
			if (currentFile != null) {
				this.invokeNotionUtilOnFile(currentFile);
			} else {
				new Notice('Sorry, no file to read!');
			}
			new Notice('Done!');
		});

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("Soup's Tasks");

		this.addSettingTab(new SettingTab(this.app, this));

		// Post tasks every minute
		this.registerInterval(window.setInterval(() => {
			// ToDo: partial refresh when there are too many tasks
			statusBarItemEl.setText("Soup's Tasks refreshing...");
			this.invokeNotionUtil();
			statusBarItemEl.setText("Soup's Tasks");
		}, 1 * 60 * 1000));

		// Clean up notion pages when the task is deleted
		this.app.vault.on("delete", async file => {
			if (file instanceof TFile) {
				const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter;
        		if (metadata != undefined) await this.notionUtil.cleanUpTask(metadata);
			}
		})
	}

	onunload() {

	}

	async invokeNotionUtilOnFile(file: TFile) {
		this.notionUtil.createOrUpdateTask(file);
	}

	async invokeNotionUtil() {
		const allFiles = this.app.vault.getMarkdownFiles();
		const currentFile = this.app.workspace.getActiveFile();
		// Don't mess with the user's active file
		if (currentFile) allFiles.remove(currentFile);
		allFiles.forEach(async file =>  {
			await this.invokeNotionUtilOnFile(file);
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SettingTab extends PluginSettingTab {
	plugin: SoupsTasksPlugin;

	constructor(app: App, plugin: SoupsTasksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Notion API key')
			.setDesc('Set your workflow api key here')
			.addText(text => text
				.setPlaceholder('Enter your api key')
				.setValue(this.plugin.settings.notionApiKey)
				.onChange(async (value) => {
					this.plugin.settings.notionApiKey = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Notion Database Id')
			.setDesc('Set the Id of your tasks table here')
			.addText(text => text
				.setPlaceholder('Enter your table id')
				.setValue(this.plugin.settings.notionTaskDb)
				.onChange(async (value) => {
					this.plugin.settings.notionTaskDb = value;
					await this.plugin.saveSettings();
				}));
	}
}
