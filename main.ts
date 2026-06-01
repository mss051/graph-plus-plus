import { App, Notice, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, TFile, setIcon, MarkdownView } from 'obsidian';

// ---------------------------------------------------------
// 1. DATA STRUCTURES & SETTINGS
// ---------------------------------------------------------

export const SMART_GRAPH_VIEW_TYPE = "smart-graph-view";
export const SMART_LOCAL_GRAPH_VIEW_TYPE = "smart-local-graph-standalone-view";

interface ClusterData {
	id: string; 
	name: string; 
	color: string; 
	isCustomColor?: boolean; 
}

interface ViewSettings {
	repulsionForce: number;
	linkDistance: number;
	linkStrength: number;
	centerGravity: number;

	showAllLabels: boolean;
	whiteLabels: boolean;
	hoverLinkColor: string; 
	labelVisibilityThreshold: number; 
	absoluteCenterDistance: number; 
	spawnAnimation: 'hierarchical' | 'radial';

	enableColors: boolean;
	enableGlow: boolean;
	glowIntensity: number;
	nodeMinRadius: number;
	nodeMaxRadius: number;
	fontSizeMin: number;
	fontSizeMax: number;
	linkWidthBase: number;
	linkWidthHover: number;

	centerNodeFontColor: string;
	centerNodeFontStyle: 'normal' | 'bold' | 'italic' | 'bold-italic';
	centerNodeMatchColor: boolean;

	hubNodeFontColor: string;
	hubNodeFontStyle: 'normal' | 'bold' | 'italic' | 'bold-italic';
	hubNodeMatchColor: boolean;

	standardNodeFontColor: string;
	standardNodeFontStyle: 'normal' | 'bold' | 'italic' | 'bold-italic';
	standardNodeMatchColor: boolean;
}

const DEFAULT_VIEW_SETTINGS: ViewSettings = {
	repulsionForce: 200, 
	linkDistance: 115,
	linkStrength: 0.038,
	centerGravity: 0.1,

	showAllLabels: false,
	whiteLabels: false,
	hoverLinkColor: "var(--color-purple)", 
	labelVisibilityThreshold: 0,
	absoluteCenterDistance: 10,
	spawnAnimation: 'radial',

	enableColors: true,
	enableGlow: true,
	glowIntensity: 1.0,
	nodeMinRadius: 6,
	nodeMaxRadius: 35,
	fontSizeMin: 12,
	fontSizeMax: 18,
	linkWidthBase: 1.0,
	linkWidthHover: 2.0,

	centerNodeFontColor: "#ffffff",
	centerNodeFontStyle: "bold",
	centerNodeMatchColor: false,

	hubNodeFontColor: "#dddddd",
	hubNodeFontStyle: "bold",
	hubNodeMatchColor: false,

	standardNodeFontColor: "#aaaaaa",
	standardNodeFontStyle: "normal",
	standardNodeMatchColor: false
};

interface GraphClusterSettings {
	clusters: ClusterData[];
	nodeColors: Record<string, string>; 
	nodePrimaryClusters: Record<string, string>; 
	absoluteCenters: string[]; 
	
	showLocalGraphInEditor: boolean;
	localGraphHeight: number;
	localGraphZoomThreshold: number; 

	globalDefaults: ViewSettings;
	globalGraph: ViewSettings;
	localGraph: ViewSettings;
}

const DEFAULT_SETTINGS: GraphClusterSettings = {
	clusters: [],
	nodeColors: {},
	nodePrimaryClusters: {},
	absoluteCenters: [],
	showLocalGraphInEditor: false, 
	localGraphHeight: 300,
	localGraphZoomThreshold: 50,
	globalDefaults: { ...DEFAULT_VIEW_SETTINGS },
	globalGraph: { ...DEFAULT_VIEW_SETTINGS },
	localGraph: { ...DEFAULT_VIEW_SETTINGS }
};

// ---------------------------------------------------------
// 2. MAIN PLUGIN CLASS
// ---------------------------------------------------------

export default class SmartGraphPlugin extends Plugin {
	settings!: GraphClusterSettings;
	floatingLocalGraph: FloatingLocalGraphManager | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(
			SMART_GRAPH_VIEW_TYPE,
			(leaf) => new SmartGraphView(leaf, this)
		);

		this.registerView(
			SMART_LOCAL_GRAPH_VIEW_TYPE,
			(leaf) => new SmartLocalGraphStandaloneView(leaf, this)
		);

		this.addSettingTab(new SmartGraphSettingTab(this.app, this));

		this.addRibbonIcon('graph-glyph', 'Open Smart Graph', () => {
			this.activateView(SMART_GRAPH_VIEW_TYPE);
		});

		this.addCommand({
			id: 'recalculate-cluster-colors',
			name: 'Recalculate Network and Colors',
			callback: () => this.runClusterAnalysis()
		});

		this.addCommand({
			id: 'open-smart-graph',
			name: 'Open Global Smart Graph',
			callback: () => this.activateView(SMART_GRAPH_VIEW_TYPE)
		});

		this.addCommand({
			id: 'open-smart-local-graph',
			name: 'Open Floating Local Graph',
			callback: () => this.toggleFloatingLocalGraph()
		});

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) {
					this.updateAllLocalGraphs();
				}
			})
		);
	}

	async onunload() {
		if (this.floatingLocalGraph) {
			this.floatingLocalGraph.destroy();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.globalDefaults) this.settings.globalDefaults = { ...DEFAULT_VIEW_SETTINGS };
		if (!this.settings.globalGraph) this.settings.globalGraph = { ...this.settings.globalDefaults };
		if (!this.settings.localGraph) this.settings.localGraph = { ...this.settings.globalDefaults };
	}

	async saveSettings(refreshGraphs = true) {
		await this.saveData(this.settings);
		if (refreshGraphs) {
			const leaves = this.app.workspace.getLeavesOfType(SMART_GRAPH_VIEW_TYPE);
			if (leaves.length > 0) {
				const view = leaves[0].view as SmartGraphView;
				view.textCache.clear(); 
				view.wakeUp(); 
				view.drawGraph(); 
			}
			this.updateAllLocalGraphs();
		}
	}

	async activateView(viewType: string, position: 'center' | 'right' = 'center') {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(viewType);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = position === 'right' ? workspace.getRightLeaf(false) : workspace.getLeaf('tab');
			if(leaf) {
				await leaf.setViewState({ type: viewType, active: true });
			}
		}

		if(leaf) workspace.revealLeaf(leaf);
	}

	toggleFloatingLocalGraph() {
		if (this.floatingLocalGraph && this.floatingLocalGraph.isVisible) {
			this.floatingLocalGraph.destroy();
			this.floatingLocalGraph = null;
			this.updateAllLocalGraphs(); 
		} else {
			const activeFile = this.app.workspace.getActiveFile();
			this.floatingLocalGraph = new FloatingLocalGraphManager(this);
			if (activeFile) this.floatingLocalGraph.updateGraph(activeFile);
			this.updateAllLocalGraphs(); 
		}
	}

	updateAllLocalGraphs() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return;

		const isFloatingActive = this.floatingLocalGraph && this.floatingLocalGraph.isVisible;

		const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
		markdownLeaves.forEach(leaf => {
			const view = leaf.view as MarkdownView;
			if (view.file !== activeFile) return; 
			
			const contentEl = view.contentEl;
			let wrapper = contentEl.querySelector('.smart-local-graph-wrapper') as HTMLElement;

			if (!this.settings.showLocalGraphInEditor || isFloatingActive) {
				if (wrapper) wrapper.remove();
				return;
			}

			if (!wrapper) {
				wrapper = document.createElement('div');
				wrapper.className = 'smart-local-graph-wrapper';
				wrapper.style.width = '100%';
				wrapper.style.flexShrink = '0'; 
				wrapper.style.borderBottom = '1px solid var(--background-modifier-border)';
				wrapper.style.position = 'relative';
				wrapper.style.overflow = 'hidden';
				contentEl.insertBefore(wrapper, contentEl.firstChild);
			}
			
			wrapper.style.height = `${this.settings.localGraphHeight}px`;
			wrapper.empty(); 
			new SmartLocalGraphRenderer(wrapper, activeFile, this, false);
		});

		if (this.floatingLocalGraph && this.floatingLocalGraph.isVisible) {
			this.floatingLocalGraph.updateGraph(activeFile);
		}
	}

	async runClusterAnalysis() {
		new Notice("Starting network analysis...");

		const graph = this.buildBidirectionalGraph();
		if (graph.size === 0) {
			new Notice("The graph is empty or has no links.");
			return;
		}

		let hubPaths = this.identifyHubsViaCommunities(graph);
		if (hubPaths.length === 0) {
			hubPaths = Array.from(graph.entries())
				.sort((a, b) => b[1].size - a[1].size)
				.slice(0, 6)
				.filter(entry => entry[1].size > 0)
				.map(entry => entry[0]);
		}

		if (hubPaths.length === 0) {
			new Notice("Non ci sono abbastanza collegamenti nel Vault per creare dei gruppi.");
			return;
		}

		const candidateCenters: string[] = [];
		const files = this.app.vault.getMarkdownFiles();

		for (const file of files) {
			const content = await this.app.vault.read(file);
			const cleanContent = content.replace(/^---[\s\S]*?---/, '').trim();
			if (cleanContent.length === 0) {
				const neighbors = graph.get(file.path) || new Set();
				const connectedHubs = Array.from(neighbors).filter(n => hubPaths.includes(n));
				if (connectedHubs.length >= 2) candidateCenters.push(file.path);
			}
		}

		const finalCenters = candidateCenters.filter(path => {
			const neighbors = graph.get(path) || new Set();
			for (const neighbor of neighbors) {
				if (candidateCenters.includes(neighbor)) return false; 
			}
			return true;
		});

		this.settings.absoluteCenters = finalCenters;

		this.updateClusters(hubPaths, graph);
		this.calculateNodeColors(graph);
		await this.saveSettings(false); 

		const leaves = this.app.workspace.getLeavesOfType(SMART_GRAPH_VIEW_TYPE);
		if (leaves.length > 0) {
			const view = leaves[0].view as SmartGraphView;
			view.hardReset(); 
		}
		this.updateAllLocalGraphs();

		new Notice(`Analysis complete! Detected ${hubPaths.length} macro-groups and ${finalCenters.length} absolute centers.`);
	}

	buildBidirectionalGraph(): Map<string, Set<string>> {
		const graph = new Map<string, Set<string>>();
		const resolvedLinks = this.app.metadataCache.resolvedLinks;

		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) graph.set(file.path, new Set<string>());

		for (const sourcePath in resolvedLinks) {
			if (!graph.has(sourcePath)) continue;
			for (const targetPath in resolvedLinks[sourcePath]) {
				if (!graph.has(targetPath)) continue;
				graph.get(sourcePath)?.add(targetPath);
				graph.get(targetPath)?.add(sourcePath);
			}
		}
		return graph;
	}

	identifyHubsViaCommunities(graph: Map<string, Set<string>>): string[] {
		const labels = new Map<string, string>();
		const nodes = Array.from(graph.keys());

		for (const node of nodes) labels.set(node, node);

		let changed = true;
		let iter = 0;
		const maxIter = 50; 

		while (changed && iter < maxIter) {
			changed = false;
			for (const node of nodes) {
				const neighbors = graph.get(node);
				if (!neighbors || neighbors.size === 0) continue;

				const labelCounts = new Map<string, number>();
				for (const neighbor of neighbors) {
					const neighborLabel = labels.get(neighbor)!;
					labelCounts.set(neighborLabel, (labelCounts.get(neighborLabel) || 0) + 1);
				}

				let maxCount = 0;
				let bestLabels: string[] = [];
				for (const [label, count] of labelCounts.entries()) {
					if (count > maxCount) {
						maxCount = count;
						bestLabels = [label];
					} else if (count === maxCount) {
						bestLabels.push(label);
					}
				}

				const currentLabel = labels.get(node)!;
				
				if (!bestLabels.includes(currentLabel)) {
					const newLabel = bestLabels.sort((a, b) => (graph.get(b)?.size || 0) - (graph.get(a)?.size || 0))[0];
					labels.set(node, newLabel);
					changed = true;
				}
			}
			iter++;
		}

		const communities = new Map<string, string[]>();
		for (const [node, label] of labels.entries()) {
			if (!communities.has(label)) communities.set(label, []);
			communities.get(label)!.push(node);
		}

		const hubs: string[] = [];
		for (const [label, members] of communities.entries()) {
			if (members.length < 4 && nodes.length > 20) continue;
			let bestHub = members[0];
			let maxDegree = -1;
			for (const member of members) {
				const degree = graph.get(member)?.size || 0;
				if (degree > maxDegree) { maxDegree = degree; bestHub = member; }
			}
			hubs.push(bestHub);
		}

		hubs.sort((a, b) => (graph.get(b)?.size || 0) - (graph.get(a)?.size || 0));
		return hubs;
	}

	updateClusters(newHubPaths: string[], graph: Map<string, Set<string>>) {
		const existingClusters = new Map(this.settings.clusters.map(c => [c.id, c]));
		const updatedClusters: ClusterData[] = [];
		const autoHubs: string[] = [];
		
		newHubPaths.forEach(path => {
			const existing = existingClusters.get(path);
			if (existing && existing.isCustomColor) updatedClusters.push(existing);
			else autoHubs.push(path);
		});

		if (autoHubs.length > 0) {
			const step = 360 / autoHubs.length;
			const baseHue = Math.random() * 360;
			const hues: number[] = [];

			for (let i = 0; i < autoHubs.length; i++) hues.push((baseHue + (step * i)) % 360);
			for (let i = hues.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[hues[i], hues[j]] = [hues[j], hues[i]];
			}

			autoHubs.forEach((hubPath, index) => {
				const hue = hues[index];
				const rgb = this.hslToRgb(hue / 360, 0.9, 0.6);
				const colorHex = this.rgbToHex(rgb);
				const name = hubPath.split('/').pop()?.replace('.md', '') || hubPath;

				const existing = existingClusters.get(hubPath);
				updatedClusters.push({
					id: hubPath,
					name: existing ? existing.name : name,
					color: colorHex,
					isCustomColor: false
				});
			});
		}
		this.settings.clusters = newHubPaths.map(path => updatedClusters.find(c => c.id === path)!);
	}

	calculateNodeColors(graph: Map<string, Set<string>>) {
		this.settings.nodeColors = {};
		this.settings.nodePrimaryClusters = {};
		
		const hubMap = new Map(this.settings.clusters.map(c => [c.id, c]));
		const absoluteCentersSet = new Set(this.settings.absoluteCenters || []);

		for (const [nodePath, neighbors] of graph.entries()) {
			if (absoluteCentersSet.has(nodePath)) {
				this.settings.nodeColors[nodePath] = "#ffd700";
				this.settings.nodePrimaryClusters[nodePath] = "";
				continue;
			}
			if (hubMap.has(nodePath)) {
				this.settings.nodeColors[nodePath] = hubMap.get(nodePath)!.color;
				this.settings.nodePrimaryClusters[nodePath] = nodePath; 
				continue;
			}

			const influences = new Map<string, number>(); 
			let totalWeight = 0;

			for (const cluster of this.settings.clusters) {
				let score = 0;
				const hubNeighbors = graph.get(cluster.id) || new Set();
				if (neighbors.has(cluster.id)) score += 1.0;
				for (const neighbor of neighbors) if (hubNeighbors.has(neighbor)) score += 0.2; 
				
				if (score > 0) {
					const weight = Math.pow(score, 2); 
					influences.set(cluster.id, weight);
					totalWeight += weight;
				}
			}

			if (totalWeight > 0) {
				let r = 0, g = 0, b = 0;
				let maxWeight = -1;
				let primaryHub = "";

				for (const [hubId, weight] of influences.entries()) {
					if (weight > maxWeight) { maxWeight = weight; primaryHub = hubId; }
					const hex = hubMap.get(hubId)!.color;
					const rgb = this.hexToRgb(hex);
					r += rgb.r * (weight / totalWeight);
					g += rgb.g * (weight / totalWeight);
					b += rgb.b * (weight / totalWeight);
				}
				this.settings.nodeColors[nodePath] = this.rgbToHex({r: Math.round(r), g: Math.round(g), b: Math.round(b)});
				this.settings.nodePrimaryClusters[nodePath] = primaryHub;
			} else {
				this.settings.nodeColors[nodePath] = "#666666";
				this.settings.nodePrimaryClusters[nodePath] = "";
			}
		}
	}

	hslToRgb(h: number, s: number, l: number): {r: number, g: number, b: number} {
		let r, g, b;
		if (s === 0) { r = g = b = l; } 
		else {
			const hue2rgb = (p: number, q: number, t: number) => {
				if (t < 0) t += 1;
				if (t > 1) t -= 1;
				if (t < 1/6) return p + (q - p) * 6 * t;
				if (t < 1/2) return q;
				if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
				return p;
			};
			const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
			const p = 2 * l - q;
			r = hue2rgb(p, q, h + 1/3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1/3);
		}
		return {r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255)};
	}

	rgbToHex(rgb: {r: number, g: number, b: number}): string {
		const toHex = (c: number) => { const hex = c.toString(16); return hex.length == 1 ? "0" + hex : hex; };
		return "#" + toHex(rgb.r) + toHex(rgb.g) + toHex(rgb.b);
	}

	hexToRgb(hex: string): {r: number, g: number, b: number} {
		const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
		return result ? {
			r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16)
		} : {r: 128, g: 128, b: 128};
	}
}

// ---------------------------------------------------------
// 4. SETTINGS PANEL (OBSIDIAN NATIVE)
// ---------------------------------------------------------

class SmartGraphSettingTab extends PluginSettingTab {
	plugin: SmartGraphPlugin;

	constructor(app: App, plugin: SmartGraphPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Smart Graph Settings' });
		containerEl.createEl('p', { text: 'Queste impostazioni stabiliscono i valori di Default Globali per tutti i grafi. Puoi comunque sovrascriverle localmente usando il menù fluttuante all\'interno di ogni singola visualizzazione.', cls: 'setting-item-description' });

		containerEl.createEl('h3', { text: 'Local Graph Integration' });
		new Setting(containerEl)
			.setName('Abilita Grafo Locale nell\'Editor')
			.setDesc('Mostra un banner in cima alla nota con i suoi collegamenti. (Viene disabilitato se apri la finestra fluttuante)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showLocalGraphInEditor)
				.onChange(async (value) => {
					this.plugin.settings.showLocalGraphInEditor = value;
					await this.plugin.saveSettings();
				}));
				
		new Setting(containerEl)
			.setName('Soglia Zoom Grafo Locale')
			.setDesc('Numero massimo di nodi prima che lo zoom automatico si blocchi per mantenere la leggibilità.')
			.addSlider(slider => slider
				.setLimits(10, 200, 10)
				.setValue(this.plugin.settings.localGraphZoomThreshold)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.localGraphZoomThreshold = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Global Defaults - Visuals' });

		new Setting(containerEl).setName('Spawn Animation').addDropdown(dropdown => dropdown
			.addOption('radial', 'Radial Burst')
			.addOption('hierarchical', 'Hierarchical Wave')
			.setValue(this.plugin.settings.globalDefaults.spawnAnimation)
			.onChange(async (val) => { this.plugin.settings.globalDefaults.spawnAnimation = val as any; await this.plugin.saveSettings(); })
		);
		new Setting(containerEl).setName('Enable Node Colors').addToggle(toggle => toggle
			.setValue(this.plugin.settings.globalDefaults.enableColors)
			.onChange(async (val) => { this.plugin.settings.globalDefaults.enableColors = val; await this.plugin.saveSettings(); })
		);
		new Setting(containerEl).setName('Enable Glow Effects').addToggle(toggle => toggle
			.setValue(this.plugin.settings.globalDefaults.enableGlow)
			.onChange(async (val) => { this.plugin.settings.globalDefaults.enableGlow = val; await this.plugin.saveSettings(); })
		);
		new Setting(containerEl).setName('Glow Intensity').addSlider(slider => slider
			.setLimits(0.1, 3.0, 0.1).setValue(this.plugin.settings.globalDefaults.glowIntensity).setDynamicTooltip()
			.onChange(async (val) => { this.plugin.settings.globalDefaults.glowIntensity = val; await this.plugin.saveSettings(); })
		);

		containerEl.createEl('h3', { text: 'Global Defaults - Typography' });

		new Setting(containerEl).setName('Font Size Base').addSlider(slider => slider
			.setLimits(6, 24, 1).setValue(this.plugin.settings.globalDefaults.fontSizeMin).setDynamicTooltip()
			.onChange(async (val) => { this.plugin.settings.globalDefaults.fontSizeMin = val; await this.plugin.saveSettings(); })
		);
		new Setting(containerEl).setName('Font Size Max').addSlider(slider => slider
			.setLimits(10, 36, 1).setValue(this.plugin.settings.globalDefaults.fontSizeMax).setDynamicTooltip()
			.onChange(async (val) => { this.plugin.settings.globalDefaults.fontSizeMax = val; await this.plugin.saveSettings(); })
		);

		// Typography: Center Node
		new Setting(containerEl).setName('Center Node - Match Node Color').addToggle(toggle => toggle
			.setValue(this.plugin.settings.globalDefaults.centerNodeMatchColor)
			.onChange(async (val) => { this.plugin.settings.globalDefaults.centerNodeMatchColor = val; await this.plugin.saveSettings(); this.display(); })
		);
		if (!this.plugin.settings.globalDefaults.centerNodeMatchColor) {
			new Setting(containerEl).setName('Center Node - Font Color').addText(text => text
				.setValue(this.plugin.settings.globalDefaults.centerNodeFontColor)
				.onChange(async (val) => { this.plugin.settings.globalDefaults.centerNodeFontColor = val; await this.plugin.saveSettings(); })
			);
		}
		new Setting(containerEl).setName('Center Node - Font Style').addDropdown(dropdown => dropdown
			.addOption('normal', 'Normal').addOption('bold', 'Bold').addOption('italic', 'Italic').addOption('bold-italic', 'Bold Italic')
			.setValue(this.plugin.settings.globalDefaults.centerNodeFontStyle)
			.onChange(async (val) => { this.plugin.settings.globalDefaults.centerNodeFontStyle = val as any; await this.plugin.saveSettings(); })
		);

		// Typography: Hub Node
		new Setting(containerEl).setName('Hub Node - Match Node Color').addToggle(toggle => toggle
			.setValue(this.plugin.settings.globalDefaults.hubNodeMatchColor)
			.onChange(async (val) => { this.plugin.settings.globalDefaults.hubNodeMatchColor = val; await this.plugin.saveSettings(); this.display(); })
		);
		if (!this.plugin.settings.globalDefaults.hubNodeMatchColor) {
			new Setting(containerEl).setName('Hub Node - Font Color').addText(text => text
				.setValue(this.plugin.settings.globalDefaults.hubNodeFontColor)
				.onChange(async (val) => { this.plugin.settings.globalDefaults.hubNodeFontColor = val; await this.plugin.saveSettings(); })
			);
		}
		new Setting(containerEl).setName('Hub Node - Font Style').addDropdown(dropdown => dropdown
			.addOption('normal', 'Normal').addOption('bold', 'Bold').addOption('italic', 'Italic').addOption('bold-italic', 'Bold Italic')
			.setValue(this.plugin.settings.globalDefaults.hubNodeFontStyle)
			.onChange(async (val) => { this.plugin.settings.globalDefaults.hubNodeFontStyle = val as any; await this.plugin.saveSettings(); })
		);

		// Typography: Standard Node
		new Setting(containerEl).setName('Standard Node - Match Node Color').addToggle(toggle => toggle
			.setValue(this.plugin.settings.globalDefaults.standardNodeMatchColor)
			.onChange(async (val) => { this.plugin.settings.globalDefaults.standardNodeMatchColor = val; await this.plugin.saveSettings(); this.display(); })
		);
		if (!this.plugin.settings.globalDefaults.standardNodeMatchColor) {
			new Setting(containerEl).setName('Standard Node - Font Color').addText(text => text
				.setValue(this.plugin.settings.globalDefaults.standardNodeFontColor)
				.onChange(async (val) => { this.plugin.settings.globalDefaults.standardNodeFontColor = val; await this.plugin.saveSettings(); })
			);
		}
		new Setting(containerEl).setName('Standard Node - Font Style').addDropdown(dropdown => dropdown
			.addOption('normal', 'Normal').addOption('bold', 'Bold').addOption('italic', 'Italic').addOption('bold-italic', 'Bold Italic')
			.setValue(this.plugin.settings.globalDefaults.standardNodeFontStyle)
			.onChange(async (val) => { this.plugin.settings.globalDefaults.standardNodeFontStyle = val as any; await this.plugin.saveSettings(); })
		);

		containerEl.createEl('h3', { text: 'Global Defaults - Forces' });
		new Setting(containerEl).setName('Repel Force').addSlider(slider => slider
			.setLimits(0, 15000, 100).setValue(this.plugin.settings.globalDefaults.repulsionForce).setDynamicTooltip()
			.onChange(async (val) => { this.plugin.settings.globalDefaults.repulsionForce = val; await this.plugin.saveSettings(); })
		);
		new Setting(containerEl).setName('Link Distance').addSlider(slider => slider
			.setLimits(10, 500, 5).setValue(this.plugin.settings.globalDefaults.linkDistance).setDynamicTooltip()
			.onChange(async (val) => { this.plugin.settings.globalDefaults.linkDistance = val; await this.plugin.saveSettings(); })
		);

		containerEl.createEl('h3', { text: 'Cluster Colors Management' });
		for (const cluster of this.plugin.settings.clusters) {
			new Setting(containerEl)
				.setName(`Group: ${cluster.name}`)
				.setDesc(`Hub: ${cluster.id}`)
				.addColorPicker(color => color
					.setValue(cluster.color)
					.onChange(async (value) => {
						cluster.color = value;
						cluster.isCustomColor = true; 
						await this.plugin.saveSettings();
					})
				);
		}
	}
}

// ---------------------------------------------------------
// 5. CUSTOM VIEW & GRAPH CONSTANTS
// ---------------------------------------------------------

const GRAPH_CONSTANTS = {
	PHYSICS: {
		FRICTION_ACTIVE: 0.70,     
		FRICTION_IDLE: 0.10,       
		ENERGY_DECAY: 0.96,        
		MAX_VELOCITY: 45,
		LERP_SPEED: 0.12,
		MIN_DIST_SQ: 100,
		MAX_FORCE: 50,
		GRAVITY_PLATEAU: 800,
		SLEEP_VELOCITY_THRESHOLD: 0.05, 
		SLEEP_FRAME_THRESHOLD: 30,
		WAVE_DURATION_FRAMES: 90,
		SPAWN_AREA: 1000 
	},
	VISUALS: {
		NODE_HUB_RADIUS: 12,
		NODE_CENTER_RADIUS: 30,
		TEXT_PADDING: 8,
		OPACITY_UNFOCUSED_NODE: 0.35, 
		OPACITY_UNFOCUSED_LINK: 0.05, 
		OPACITY_BASE_LINK: 0.20,
		OPACITY_GROUP_HIGHLIGHT_LINK: 0.45, 
		HOVER_FADE_IN_SPEED: 0.1,
		HOVER_FADE_OUT_SPEED: 0.15,
		CENTER_GLOW_BLUR: 12,
		NODE_HOVER_SCALE: 1.25, 
		NODE_GROUP_HIGHLIGHT_SCALE: 1.15, 
		TEXT_HOVER_SCALE: 1.3,
		MIN_HOVER_TEXT_SIZE_SCREEN: 14,
		GROUP_HIGHLIGHT_GLOW_BLUR: 25,
		VISUAL_LERP_SPEED: 0.15,
		RADIAL_WAVE_SPEED: 40, 
		RADIAL_WAVE_DELAY: 5, 
		RADIAL_WAVE1_THICKNESS: 400, 
		RADIAL_WAVE2_OFFSET: 500,    
		RADIAL_WAVE2_THICKNESS: 250, 
		RADIAL_GLOW_MAX_INTENSITY: 60 
	},
	COLORS: {
		DEFAULT_NODE: "#888888",
		CENTER_NODE: "#ffd700",
		CENTER_BORDER: "rgba(255, 215, 0, 0.6)",
		CENTER_GLOW: "rgba(255, 215, 0, 0.8)",
		TEXT_WHITE: "#ffffff",
		TEXT_DEFAULT_VAR: "var(--text-normal)",
		TEXT_FALLBACK: "#dddddd"
	}
};

class SmartGraphView extends ItemView {
	plugin: SmartGraphPlugin;
	canvas!: HTMLCanvasElement;
	ctx!: CanvasRenderingContext2D;
	animationFrameId: number = 0;
	currentFrame: number = 0;
	
	nodes: any[] = [];
	edges: any[] = [];

	transform = { x: 0, y: 0, k: 1 };
	targetTransform = { x: 0, y: 0, k: 1 };

	isDragging = false;
	dragStartX = 0;
	dragStartY = 0;
	draggedNode: any = null;
	hoveredNode: any = null; 
	
	resolvedHoverColor: string = '#a882ff';
	isSleeping: boolean = false;
	stableFrames: number = 0;
	energy: number = 1.0; 
	isFullySpawned: boolean = false; 

	textCache: Map<string, HTMLCanvasElement> = new Map();

	// Handlers legati all'istanza per essere rimossi correttamente dal document
	boundMouseMove: (e: MouseEvent) => void;
	boundMouseUp: (e: MouseEvent) => void;

	constructor(leaf: WorkspaceLeaf, plugin: SmartGraphPlugin) {
		super(leaf);
		this.plugin = plugin;

		this.boundMouseMove = (e: MouseEvent) => this.handleGlobalMouseMove(e);
		this.boundMouseUp = (e: MouseEvent) => this.handleGlobalMouseUp(e);
	}

	getViewType(): string { return SMART_GRAPH_VIEW_TYPE; }
	getDisplayText(): string { return "Smart Graph"; }
	getIcon(): string { return "graph-glyph"; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.style.overflow = 'hidden';
		container.style.padding = '0';
		container.style.position = 'relative'; 

		this.updateResolvedColor();
		this.buildOverlayUI(container);

		this.canvas = document.createElement('canvas');
		this.canvas.style.display = 'block';
		this.canvas.style.backgroundColor = 'var(--background-primary)'; 
		container.appendChild(this.canvas);

		this.ctx = this.canvas.getContext('2d', { alpha: true })!; 

		const resizeObserver = new ResizeObserver(() => {
			const dpr = window.devicePixelRatio || 1;
			const rect = container.getBoundingClientRect();
			this.canvas.width = rect.width * dpr;
			this.canvas.height = rect.height * dpr;
			this.canvas.style.width = `${rect.width}px`;
			this.canvas.style.height = `${rect.height}px`;

			if (this.transform.x === 0 && this.transform.y === 0) {
				this.transform.x = rect.width / 2;
				this.transform.y = rect.height / 2;
				this.transform.k = 0.8; 
				this.targetTransform = {...this.transform};
			}
			this.drawGraph();
		});
		resizeObserver.observe(container);

		this.canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			const zoomSensitivity = 0.0012; 
			const delta = -e.deltaY * zoomSensitivity;
			const newScale = Math.max(0.05, Math.min(10, this.targetTransform.k * Math.exp(delta)));
			
			const rect = this.canvas.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			this.targetTransform.x = mouseX - (mouseX - this.targetTransform.x) * (newScale / this.targetTransform.k);
			this.targetTransform.y = mouseY - (mouseY - this.targetTransform.y) * (newScale / this.targetTransform.k);
			this.targetTransform.k = newScale;
			this.wakeUp();
			this.drawGraph();
		});

		this.canvas.addEventListener('mousedown', (e) => {
			if (e.button === 1) e.preventDefault();
			const rect = this.canvas.getBoundingClientRect();
			const logicX = (e.clientX - rect.left - this.targetTransform.x) / this.targetTransform.k;
			const logicY = (e.clientY - rect.top - this.targetTransform.y) / this.targetTransform.k;
			
			this.draggedNode = null;
			
			for (let i = this.nodes.length - 1; i >= 0; i--) {
				const node = this.nodes[i];
				if (this.plugin.settings.globalGraph.spawnAnimation === 'hierarchical' && !node.isActive) continue; 
				const dx = logicX - node.x; const dy = logicY - node.y;
				if (dx * dx + dy * dy <= Math.pow(node.radius + 5, 2)) {
					this.draggedNode = node;
					break;
				}
			}

			if (this.draggedNode) {
				this.canvas.style.cursor = 'grabbing';
				this.wakeUp(); 
			} else {
				this.isDragging = true;
				this.canvas.style.cursor = 'move';
				this.dragStartX = e.clientX - this.transform.x;
				this.dragStartY = e.clientY - this.transform.y;
			}

			// Innesca il drag globale
			document.addEventListener('mousemove', this.boundMouseMove);
			document.addEventListener('mouseup', this.boundMouseUp);
		});

		// Hover listener locale al canvas
		this.canvas.addEventListener('mousemove', (e) => {
			if (this.isDragging || this.draggedNode) return; // Gestito dal listener globale

			const rect = this.canvas.getBoundingClientRect();
			const logicX = (e.clientX - rect.left - this.targetTransform.x) / this.targetTransform.k;
			const logicY = (e.clientY - rect.top - this.targetTransform.y) / this.targetTransform.k;

			let foundHover = null;
			for (let i = this.nodes.length - 1; i >= 0; i--) {
				const node = this.nodes[i];
				if (!node.isActive) continue; 
				const dx = logicX - node.x; const dy = logicY - node.y;
				if (dx * dx + dy * dy <= Math.pow(node.radius + 3, 2)) {
					foundHover = node; break;
				}
			}
			if (foundHover !== this.hoveredNode) {
				this.hoveredNode = foundHover;
				this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
				this.wakeUp();
				this.drawGraph();
			}
		});

		this.canvas.addEventListener('mouseleave', () => {
			if (!this.isDragging && !this.draggedNode) {
				this.hoveredNode = null;
				this.canvas.style.cursor = 'grab';
				this.wakeUp();
			}
		});

		this.initPhysicsData();
		this.startSimulation();
	}

	handleGlobalMouseMove(e: MouseEvent) {
		if (this.draggedNode) {
			const rect = this.canvas.getBoundingClientRect();
			this.draggedNode.x = (e.clientX - rect.left - this.targetTransform.x) / this.targetTransform.k;
			this.draggedNode.y = (e.clientY - rect.top - this.targetTransform.y) / this.targetTransform.k;
			this.draggedNode.vx = 0; this.draggedNode.vy = 0;
			this.wakeUp(); 
		} else if (this.isDragging) {
			this.transform.x = e.clientX - this.dragStartX;
			this.transform.y = e.clientY - this.dragStartY;
			this.targetTransform.x = this.transform.x;
			this.targetTransform.y = this.transform.y;
			this.wakeUp();
			this.drawGraph();
		}
	}

	handleGlobalMouseUp(e: MouseEvent) {
		document.removeEventListener('mousemove', this.boundMouseMove);
		document.removeEventListener('mouseup', this.boundMouseUp);

		// Controlla se è stato un clic e non un trascinamento
		let isClick = false;
		if (this.draggedNode) {
			// Se il nodo non si è mosso quasi per niente, consideralo un click
			isClick = Math.abs(this.draggedNode.vx) < 0.5 && Math.abs(this.draggedNode.vy) < 0.5;
		}

		if (isClick && (this.draggedNode || this.hoveredNode)) {
			const targetNode = this.draggedNode || this.hoveredNode;
			const file = this.plugin.app.vault.getAbstractFileByPath(targetNode.id);
			if (file instanceof TFile) {
				if (e.button === 0) this.plugin.app.workspace.getLeaf(false).openFile(file);
				else if (e.button === 1) this.plugin.app.workspace.getLeaf(true).openFile(file);
			}
		}

		this.isDragging = false;
		this.draggedNode = null;
		this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
	}

	async onClose() { 
		cancelAnimationFrame(this.animationFrameId); 
		document.removeEventListener('mousemove', this.boundMouseMove);
		document.removeEventListener('mouseup', this.boundMouseUp);
	}

	wakeUp() {
		if (this.isSleeping || this.energy < 1.0) {
			this.isSleeping = false;
			this.stableFrames = 0;
			this.energy = 1.0;
		}
	}

	hardReset() {
		this.currentFrame = 0;
		this.isFullySpawned = false;
		this.energy = 1.0;
		this.isSleeping = false;
		this.stableFrames = 0;
		if(this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.initPhysicsData();
	}

	reloadFullGraph() { this.hardReset(); }

	updateNodeRadii() {
		const s = this.plugin.settings.globalGraph;
		for (const node of this.nodes) {
			let calculatedRadius = s.nodeMinRadius + (Math.sqrt(node.degree) * 3.5);
			if (node.isHub) calculatedRadius = Math.max(calculatedRadius, s.nodeMaxRadius * 0.7);
			node.radius = Math.min(calculatedRadius, s.nodeMaxRadius);
			if (node.isAbsoluteCenter) node.radius = s.nodeMaxRadius * 1.2; 
		}
		this.wakeUp();
	}

	resolveCSSColor(cssVar: string, fallback: string): string {
		if (cssVar && cssVar.startsWith('var(')) {
			const varName = cssVar.slice(4, -1).trim();
			const color = getComputedStyle(document.body).getPropertyValue(varName).trim();
			return color ? color : fallback;
		}
		return cssVar || fallback;
	}

	updateResolvedColor() {
		this.resolvedHoverColor = this.resolveCSSColor(this.plugin.settings.globalGraph.hoverLinkColor, '#a882ff');
	}

	getFontString(styleSetting: string, size: number) {
		let style = "normal";
		let weight = "400";
		if (styleSetting === "bold") weight = "700";
		if (styleSetting === "italic") style = "italic";
		if (styleSetting === "bold-italic") { style = "italic"; weight = "700"; }
		return `${style} ${weight} ${size}px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
	}

	getTextCanvas(text: string, fontString: string, fontSize: number, color: string, scaleLevel: number): HTMLCanvasElement {
		// Crea cache a bucket discreti per non saturare la RAM
		const safeScale = Math.min(Math.max(1, Math.ceil(scaleLevel)), 5); 
		const key = `${text}_${fontString}_${color}_${safeScale}`;
		let cached = this.textCache.get(key);
		if (cached) return cached;

		const offscreenCanvas = document.createElement('canvas');
		const offscreenCtx = offscreenCanvas.getContext('2d')!;
		
		const SUPER_SAMPLE = 4.0; 
		const baseDpr = window.devicePixelRatio || 1;
		const dpr = baseDpr * safeScale * SUPER_SAMPLE; 
		
		offscreenCtx.font = fontString;
		const textWidth = Math.ceil(offscreenCtx.measureText(text).width);
		
		const logicalWidth = textWidth + GRAPH_CONSTANTS.VISUALS.TEXT_PADDING * 2.0;
		const logicalHeight = fontSize + GRAPH_CONSTANTS.VISUALS.TEXT_PADDING * 2.0;
		
		offscreenCanvas.width = logicalWidth * dpr;
		offscreenCanvas.height = logicalHeight * dpr;
		offscreenCtx.scale(dpr, dpr);
		
		offscreenCtx.font = fontString;
		offscreenCtx.fillStyle = color;
		offscreenCtx.textAlign = 'center';
		offscreenCtx.textBaseline = 'middle';
		
		offscreenCtx.shadowColor = "rgba(0,0,0,0.8)";
		offscreenCtx.shadowBlur = 5;
		
		offscreenCtx.fillText(text, logicalWidth / 2, logicalHeight / 2);
		
		this.textCache.set(key, offscreenCanvas);
		return offscreenCanvas;
	}

	buildOverlayUI(container: HTMLElement) {
		const overlayWrapper = container.createEl('div');
		overlayWrapper.style.position = 'absolute';
		overlayWrapper.style.top = '15px';
		overlayWrapper.style.right = '15px'; 
		overlayWrapper.style.display = 'flex';
		overlayWrapper.style.flexDirection = 'column';
		overlayWrapper.style.alignItems = 'flex-end';
		overlayWrapper.style.zIndex = '10';

		const toggleBtn = overlayWrapper.createEl('div');
		toggleBtn.style.cursor = 'pointer';
		toggleBtn.style.padding = '8px';
		toggleBtn.style.backgroundColor = 'var(--background-secondary)';
		toggleBtn.style.border = '1px solid var(--background-modifier-border)';
		toggleBtn.style.borderRadius = 'var(--radius-s)';
		toggleBtn.style.color = 'var(--text-muted)';
		toggleBtn.style.transition = 'color 0.2s';
		setIcon(toggleBtn, 'settings');

		toggleBtn.addEventListener('mouseenter', () => { toggleBtn.style.color = 'var(--text-normal)'; });
		toggleBtn.addEventListener('mouseleave', () => { toggleBtn.style.color = 'var(--text-muted)'; });

		const uiPanel = overlayWrapper.createEl('div');
		uiPanel.style.backgroundColor = 'var(--background-secondary)';
		uiPanel.style.border = '1px solid var(--background-modifier-border)';
		uiPanel.style.borderRadius = 'var(--radius-m)';
		uiPanel.style.display = 'none'; 
		uiPanel.style.flexDirection = 'column';
		uiPanel.style.boxShadow = 'var(--shadow-s)';
		uiPanel.style.width = '320px'; 
		uiPanel.style.maxHeight = 'calc(100vh - 40px)'; 
		uiPanel.style.overflow = 'hidden';

		toggleBtn.addEventListener('click', () => {
			toggleBtn.style.display = 'none';
			uiPanel.style.display = 'flex';
		});

		const header = uiPanel.createEl('div');
		header.style.display = 'flex';
		header.style.justifyContent = 'space-between';
		header.style.alignItems = 'center';
		header.style.padding = '12px 16px';
		header.style.backgroundColor = 'rgba(0,0,0,0.1)';
		header.style.borderBottom = '1px solid var(--background-modifier-border)';
		
		const title = header.createEl('div', { text: 'Graph Options (Global)' });
		title.style.fontWeight = '600';
		title.style.color = 'var(--text-normal)';

		const headerIcons = header.createEl('div');
		headerIcons.style.display = 'flex';
		headerIcons.style.gap = '12px';
		headerIcons.style.alignItems = 'center';

		const recalcBtnHeader = headerIcons.createEl('div');
		recalcBtnHeader.style.cursor = 'pointer';
		recalcBtnHeader.style.color = 'var(--text-muted)';
		recalcBtnHeader.style.display = 'flex';
		setIcon(recalcBtnHeader, 'wand'); 
		recalcBtnHeader.title = 'Recalculate Network';
		
		recalcBtnHeader.addEventListener('mouseenter', () => { recalcBtnHeader.style.color = 'var(--text-normal)'; });
		recalcBtnHeader.addEventListener('mouseleave', () => { recalcBtnHeader.style.color = 'var(--text-muted)'; });
		recalcBtnHeader.addEventListener('click', async (e) => {
			e.stopPropagation();
			await this.plugin.runClusterAnalysis();
			renderControls();
		});

		const syncBtn = headerIcons.createEl('div');
		syncBtn.style.cursor = 'pointer';
		syncBtn.style.color = 'var(--text-muted)';
		syncBtn.style.display = 'flex';
		setIcon(syncBtn, 'rotate-ccw'); 
		syncBtn.title = 'Sync with Global Defaults';
		
		syncBtn.addEventListener('mouseenter', () => { syncBtn.style.color = 'var(--text-normal)'; });
		syncBtn.addEventListener('mouseleave', () => { syncBtn.style.color = 'var(--text-muted)'; });

		const closeBtn = headerIcons.createEl('div');
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.color = 'var(--text-muted)';
		closeBtn.style.display = 'flex';
		setIcon(closeBtn, 'x'); 
		closeBtn.title = 'Close Menu';

		closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'var(--text-normal)'; });
		closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'var(--text-muted)'; });

		closeBtn.addEventListener('click', () => {
			uiPanel.style.display = 'none';
			toggleBtn.style.display = 'block';
		});

		const contentContainer = uiPanel.createEl('div');
		contentContainer.style.overflowY = 'auto';
		const contentBody = contentContainer.createEl('div');
		contentBody.style.display = 'flex';
		contentBody.style.flexDirection = 'column';
		contentBody.style.gap = '16px';
		contentBody.style.padding = '16px';

		const createSection = (titleText: string, defaultOpen: boolean = true) => {
			const sectionWrapper = contentBody.createEl('div');
			sectionWrapper.style.borderBottom = '1px solid var(--background-modifier-border)';
			
			const sectionHeader = sectionWrapper.createEl('div');
			sectionHeader.style.display = 'flex';
			sectionHeader.style.alignItems = 'center';
			sectionHeader.style.justifyContent = 'space-between';
			sectionHeader.style.padding = '8px 12px';
			sectionHeader.style.cursor = 'pointer';
			sectionHeader.style.color = 'var(--text-muted)';
			sectionHeader.style.fontSize = '11px';
			sectionHeader.style.fontWeight = '600';
			sectionHeader.style.textTransform = 'uppercase';
			
			const titleObj = sectionHeader.createEl('span', { text: titleText });
			const chevron = sectionHeader.createEl('span');
			setIcon(chevron, 'chevron-down');
			chevron.style.transition = 'transform 0.2s';
			chevron.style.width = '14px';
			chevron.style.height = '14px';

			const content = sectionWrapper.createEl('div');
			content.style.display = defaultOpen ? 'flex' : 'none';
			content.style.flexDirection = 'column';
			content.style.gap = '14px';
			content.style.padding = '12px';
			
			if(!defaultOpen) chevron.style.transform = 'rotate(-90deg)';

			sectionHeader.addEventListener('click', () => {
				const isOpen = content.style.display === 'flex';
				content.style.display = isOpen ? 'none' : 'flex';
				chevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
			});

			return content;
		};

		const createSelect = (parent: HTMLElement, name: string, options: Record<string, string>, value: string, onChange: (val: string) => void) => {
			const wrapper = parent.createEl('div');
			wrapper.style.display = 'flex';
			wrapper.style.justifyContent = 'space-between';
			wrapper.style.alignItems = 'center';
			
			const label = wrapper.createEl('label', { text: name });
			label.style.fontSize = 'var(--font-ui-small)';
			label.style.color = 'var(--text-normal)';

			const select = wrapper.createEl('select');
			select.addClass('dropdown');
			select.style.maxWidth = '140px';
			
			for (const key of Object.keys(options)) {
				const option = select.createEl('option', { text: options[key], value: key });
				if (key === value) option.selected = true;
			}
			select.addEventListener('change', async (e) => onChange((e.target as HTMLSelectElement).value));
		};

		const createSlider = (parent: HTMLElement, name: string, min: number, max: number, step: number, value: number, onChange: (val: number) => void) => {
			const wrapper = parent.createEl('div');
			wrapper.style.display = 'flex';
			wrapper.style.flexDirection = 'column';
			wrapper.style.gap = '6px';
			
			const labelRow = wrapper.createEl('div');
			labelRow.style.display = 'flex';
			labelRow.style.justifyContent = 'space-between';
			
			const label = labelRow.createEl('label', { text: name });
			label.style.fontSize = 'var(--font-ui-small)';
			
			const valDisplay = labelRow.createEl('span', { text: value.toString() });
			valDisplay.style.fontSize = 'var(--font-ui-small)';
			valDisplay.style.color = 'var(--text-muted)';

			const slider = wrapper.createEl('input');
			slider.type = 'range';
			slider.addClass('slider'); 
			slider.min = min.toString();
			slider.max = max.toString();
			slider.step = step.toString();
			slider.value = value.toString();
			slider.style.width = '100%';
			
			slider.addEventListener('input', (e) => {
				const newVal = parseFloat((e.target as HTMLInputElement).value);
				valDisplay.innerText = newVal.toString();
				onChange(newVal);
			});
		};

		const createToggle = (parent: HTMLElement, name: string, value: boolean, onChange: (val: boolean) => void) => {
			const wrapper = parent.createEl('div');
			wrapper.style.display = 'flex';
			wrapper.style.justifyContent = 'space-between';
			wrapper.style.alignItems = 'center';
			
			const label = wrapper.createEl('label', { text: name });
			label.style.fontSize = 'var(--font-ui-small)';

			const toggleContainer = wrapper.createEl('div');
			toggleContainer.addClass('checkbox-container'); 
			if(value) toggleContainer.addClass('is-enabled');

			toggleContainer.addEventListener('click', async () => {
				const isEnabled = toggleContainer.hasClass('is-enabled');
				if(isEnabled) toggleContainer.removeClass('is-enabled');
				else toggleContainer.addClass('is-enabled');
				onChange(!isEnabled);
			});
		};

		const createTextInput = (parent: HTMLElement, name: string, placeholder: string, value: string, onChange: (val: string) => void) => {
			const wrapper = parent.createEl('div');
			wrapper.style.display = 'flex';
			wrapper.style.flexDirection = 'column';
			wrapper.style.gap = '6px';
			
			const label = wrapper.createEl('label', { text: name });
			label.style.fontSize = 'var(--font-ui-small)';
			label.style.color = 'var(--text-normal)';

			const input = wrapper.createEl('input');
			input.type = 'text';
			input.value = value;
			input.placeholder = placeholder;
			input.style.width = '100%';
			input.style.backgroundColor = 'var(--background-modifier-form-field)';
			input.style.border = '1px solid var(--background-modifier-border)';
			input.style.color = 'var(--text-normal)';
			input.style.padding = '4px 8px';
			input.style.borderRadius = 'var(--radius-s)';

			input.addEventListener('change', async (e) => {
				onChange((e.target as HTMLInputElement).value);
			});
		};

		const renderControls = () => {
			contentBody.empty();
			const s = this.plugin.settings.globalGraph;

			const displaySection = createSection('Display', true);
			createSelect(displaySection, 'Spawn Animation', { radial: 'Radial Burst', hierarchical: 'Hierarchical Wave' }, s.spawnAnimation, async (val) => {
				s.spawnAnimation = val as 'hierarchical' | 'radial'; await this.plugin.saveSettings(false); this.hardReset(); 
			});
			createSlider(displaySection, 'Label Visibility Threshold', 0, 3, 0.1, s.labelVisibilityThreshold, async (val) => {
				s.labelVisibilityThreshold = val; await this.plugin.saveSettings(false); this.drawGraph();
			});
			createToggle(displaySection, 'Force all labels visible', s.showAllLabels, async (val) => {
				s.showAllLabels = val; await this.plugin.saveSettings(false); this.drawGraph();
			});
			createToggle(displaySection, 'High contrast labels (White)', s.whiteLabels, async (val) => {
				s.whiteLabels = val; await this.plugin.saveSettings(false); this.drawGraph();
			});

			const typographySection = createSection('Typography', false);
			const fontStyleOptions = { 'normal': 'Normal', 'bold': 'Bold', 'italic': 'Italic', 'bold-italic': 'Bold Italic' };
			
			createSelect(typographySection, 'Absolute Center Style', fontStyleOptions, s.centerNodeFontStyle, async (val) => {
				s.centerNodeFontStyle = val as any; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
			});
			createToggle(typographySection, 'Center Match Node Color', s.centerNodeMatchColor, async (val) => {
				s.centerNodeMatchColor = val; this.textCache.clear(); await this.plugin.saveSettings(false); renderControls(); this.drawGraph();
			});
			if (!s.centerNodeMatchColor) {
				createTextInput(typographySection, 'Absolute Center Color', '#ffffff', s.centerNodeFontColor, async (val) => {
					s.centerNodeFontColor = val; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
				});
			}
			
			createSelect(typographySection, 'Hub Style', fontStyleOptions, s.hubNodeFontStyle, async (val) => {
				s.hubNodeFontStyle = val as any; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
			});
			createToggle(typographySection, 'Hub Match Node Color', s.hubNodeMatchColor, async (val) => {
				s.hubNodeMatchColor = val; this.textCache.clear(); await this.plugin.saveSettings(false); renderControls(); this.drawGraph();
			});
			if (!s.hubNodeMatchColor) {
				createTextInput(typographySection, 'Hub Color', '#dddddd', s.hubNodeFontColor, async (val) => {
					s.hubNodeFontColor = val; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
				});
			}

			createSelect(typographySection, 'Standard Style', fontStyleOptions, s.standardNodeFontStyle, async (val) => {
				s.standardNodeFontStyle = val as any; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
			});
			createToggle(typographySection, 'Standard Match Node Color', s.standardNodeMatchColor, async (val) => {
				s.standardNodeMatchColor = val; this.textCache.clear(); await this.plugin.saveSettings(false); renderControls(); this.drawGraph();
			});
			if (!s.standardNodeMatchColor) {
				createTextInput(typographySection, 'Standard Color', '#aaaaaa', s.standardNodeFontColor, async (val) => {
					s.standardNodeFontColor = val; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
				});
			}


			const appearanceSection = createSection('Appearance', false);
			createToggle(appearanceSection, 'Enable Node Colors', s.enableColors, async (val) => {
				s.enableColors = val; await this.plugin.saveSettings(false); this.drawGraph();
			});
			createToggle(appearanceSection, 'Enable Glow Effects', s.enableGlow, async (val) => {
				s.enableGlow = val; await this.plugin.saveSettings(false); this.drawGraph();
			});
			createSlider(appearanceSection, 'Glow Intensity', 0.1, 3.0, 0.1, s.glowIntensity, async (val) => {
				s.glowIntensity = val; await this.plugin.saveSettings(false); this.drawGraph();
			});
			createSlider(appearanceSection, 'Node Min Size', 1, 10, 1, s.nodeMinRadius, async (val) => {
				s.nodeMinRadius = val; this.updateNodeRadii(); await this.plugin.saveSettings(false);
			});
			createSlider(appearanceSection, 'Node Max Size', 10, 50, 1, s.nodeMaxRadius, async (val) => {
				s.nodeMaxRadius = val; this.updateNodeRadii(); await this.plugin.saveSettings(false);
			});
			createSlider(appearanceSection, 'Font Size Base', 6, 24, 1, s.fontSizeMin, async (val) => {
				s.fontSizeMin = val; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
			});
			createSlider(appearanceSection, 'Font Size Max', 10, 36, 1, s.fontSizeMax, async (val) => {
				s.fontSizeMax = val; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
			});

			const forceSection = createSection('Forces', false);
			createSlider(forceSection, 'Repel Force', 0, 15000, 100, s.repulsionForce, async (val) => {
				s.repulsionForce = val; await this.plugin.saveSettings(false); this.wakeUp();
			});
			createSlider(forceSection, 'Hub to Center Distance', 10, 2000, 10, s.absoluteCenterDistance, async (val) => {
				s.absoluteCenterDistance = val; await this.plugin.saveSettings(false); this.wakeUp();
			});
			createSlider(forceSection, 'Link Distance', 10, 500, 5, s.linkDistance, async (val) => {
				s.linkDistance = val; await this.plugin.saveSettings(false); this.wakeUp();
			});
		};

		renderControls();

		syncBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			this.plugin.settings.globalGraph = JSON.parse(JSON.stringify(this.plugin.settings.globalDefaults));
			await this.plugin.saveSettings(false);
			this.updateResolvedColor();
			this.updateNodeRadii();
			renderControls();
			this.hardReset();
		});
	}

	stepPhysics(isPrecalc: boolean = false): number {
		const s = this.plugin.settings.globalGraph;
		const repulsionConstant = s.repulsionForce; 
		const baseSpringConstant = s.linkStrength;
		const baseSpringLength = s.linkDistance;
		const absCenterDistance = s.absoluteCenterDistance;
		const gravity = s.centerGravity;

		const currentFriction = isPrecalc 
			? 0.25 
			: GRAPH_CONSTANTS.PHYSICS.FRICTION_IDLE + (GRAPH_CONSTANTS.PHYSICS.FRICTION_ACTIVE - GRAPH_CONSTANTS.PHYSICS.FRICTION_IDLE) * this.energy;

		for (let i = 0; i < this.nodes.length; i++) {
			const n1 = this.nodes[i];
			if (!n1.isActive && !isPrecalc) continue; 
			
			for (let j = i + 1; j < this.nodes.length; j++) {
				const n2 = this.nodes[j];
				if (!n2.isActive && !isPrecalc) continue; 

				const dx = n1.x - n2.x;
				const dy = n1.y - n2.y;
				let distSq = dx * dx + dy * dy;
				if (distSq < GRAPH_CONSTANTS.PHYSICS.MIN_DIST_SQ) distSq = GRAPH_CONSTANTS.PHYSICS.MIN_DIST_SQ; 
				
				const factor = (repulsionConstant * 2) / distSq;
				n1.vx += dx * factor; n1.vy += dy * factor;
				n2.vx -= dx * factor; n2.vy -= dy * factor;
			}
		}

		for (const edge of this.edges) {
			const n1 = this.nodes[edge.sourceIndex];
			const n2 = this.nodes[edge.targetIndex];
			if ((!n1.isActive || !n2.isActive) && !isPrecalc) continue; 
			
			const dx = n2.x - n1.x;
			const dy = n2.y - n1.y;
			const distSq = dx * dx + dy * dy; 
			if (distSq === 0) continue;
			const dist = Math.sqrt(distSq); 

			const isSameCluster = n1.color === n2.color;
			let springLength = isSameCluster ? baseSpringLength * 0.8 : baseSpringLength * 1.5;
			const springConstant = isSameCluster ? baseSpringConstant * 1.1 : baseSpringConstant * 0.4;

			if ((n1.isAbsoluteCenter && n2.isHub) || (n2.isAbsoluteCenter && n1.isHub)) {
				springLength = Math.max(springLength, absCenterDistance);
			}

			let force = (dist - springLength) * springConstant;
			if (force > GRAPH_CONSTANTS.PHYSICS.MAX_FORCE) force = GRAPH_CONSTANTS.PHYSICS.MAX_FORCE;
			if (force < -GRAPH_CONSTANTS.PHYSICS.MAX_FORCE) force = -GRAPH_CONSTANTS.PHYSICS.MAX_FORCE;

			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;

			n1.vx += fx; n1.vy += fy;
			n2.vx -= fx; n2.vy -= fy;
		}

		let totalVelocity = 0; 
		for (const node of this.nodes) {
			if (!node.isActive && !isPrecalc) continue;
			if (node === this.draggedNode) continue; 

			const distSq = node.x * node.x + node.y * node.y;
			if (distSq > 0) {
				const dist = Math.sqrt(distSq);
				const gravForce = gravity * Math.min(dist, GRAPH_CONSTANTS.PHYSICS.GRAVITY_PLATEAU) / dist; 
				node.vx -= node.x * gravForce;
				node.vy -= node.y * gravForce;
			}

			const speedSq = node.vx * node.vx + node.vy * node.vy;
			if (speedSq > GRAPH_CONSTANTS.PHYSICS.MAX_VELOCITY * GRAPH_CONSTANTS.PHYSICS.MAX_VELOCITY) {
				const speed = Math.sqrt(speedSq);
				node.vx = (node.vx / speed) * GRAPH_CONSTANTS.PHYSICS.MAX_VELOCITY;
				node.vy = (node.vy / speed) * GRAPH_CONSTANTS.PHYSICS.MAX_VELOCITY;
			}

			node.vx *= currentFriction;
			node.vy *= currentFriction;

			if (Math.abs(node.vx) < GRAPH_CONSTANTS.PHYSICS.SLEEP_VELOCITY_THRESHOLD) node.vx = 0;
			if (Math.abs(node.vy) < GRAPH_CONSTANTS.PHYSICS.SLEEP_VELOCITY_THRESHOLD) node.vy = 0;

			node.x += node.vx;
			node.y += node.vy;
			totalVelocity += Math.abs(node.vx) + Math.abs(node.vy);
		}
		return totalVelocity;
	}

	initPhysicsData() {
		this.nodes = [];
		this.edges = [];
		const s = this.plugin.settings.globalGraph;
		
		const graphMap = this.plugin.buildBidirectionalGraph();
		const nodeIndexMap = new Map<string, number>();

		const hubMap = new Map(this.plugin.settings.clusters.map(c => [c.id, c]));
		const absoluteCentersSet = new Set(this.plugin.settings.absoluteCenters || []);
		const primaryClusters = this.plugin.settings.nodePrimaryClusters || {};

		const tempNodes = [];
		const initialPositions = new Map<string, {x: number, y: number}>();

		for (const [path, neighbors] of graphMap.entries()) {
			const isHub = hubMap.has(path);
			const isAbsoluteCenter = absoluteCentersSet.has(path);
			if (isAbsoluteCenter) {
				initialPositions.set(path, { x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 10 });
			} else if (isHub) {
				const angle = Math.random() * Math.PI * 2;
				const dist = s.absoluteCenterDistance + (Math.random() * 50 - 25);
				initialPositions.set(path, { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist });
			}
		}

		for (const [path, neighbors] of graphMap.entries()) {
			const color = this.plugin.settings.nodeColors[path] || GRAPH_CONSTANTS.COLORS.DEFAULT_NODE;
			const name = path.split('/').pop()?.replace('.md', '') || path;
			
			const degree = neighbors.size;
			const isHub = hubMap.has(path);
			const isAbsoluteCenter = absoluteCentersSet.has(path);
			const primaryClusterId = primaryClusters[path] || "";
			const primaryColor = primaryClusterId ? hubMap.get(primaryClusterId)?.color : undefined;
			
			let calculatedRadius = s.nodeMinRadius + (Math.sqrt(degree) * 3.5);
			if (isHub) calculatedRadius = Math.max(calculatedRadius, s.nodeMaxRadius * 0.7);
			let radius = Math.min(calculatedRadius, s.nodeMaxRadius);
			if (isAbsoluteCenter) radius = s.nodeMaxRadius * 1.2; 

			let startX = 0, startY = 0;
			if (isAbsoluteCenter || isHub) {
				const pos = initialPositions.get(path);
				startX = pos!.x; startY = pos!.y;
			} else {
				if (primaryClusterId && initialPositions.has(primaryClusterId)) {
					const parentPos = initialPositions.get(primaryClusterId)!;
					startX = parentPos.x + (Math.random() - 0.5) * 40;
					startY = parentPos.y + (Math.random() - 0.5) * 40;
				} else {
					startX = (Math.random() - 0.5) * 40;
					startY = (Math.random() - 0.5) * 40;
				}
			}

			const isActiveByDefault = s.spawnAnimation === 'radial';

			tempNodes.push({
				id: path, name, color, radius,
				x: startX, y: startY, vx: 0, vy: 0,
				isAbsoluteCenter, isHub, primaryCluster: primaryClusterId, primaryColor: primaryColor,
				degree: degree, spawnFrame: 0, isActive: false, 
				visualRadius: 0, visualOpacity: 0, visualGlow: 0, visualTextOpacity: 0,
				waveGlow1: 0, waveGlow2: 0, targetX: startX, targetY: startY
			});
		}

		tempNodes.sort((a, b) => {
			if (a.isAbsoluteCenter && !b.isAbsoluteCenter) return -1;
			if (!a.isAbsoluteCenter && b.isAbsoluteCenter) return 1;
			if (a.isHub && !b.isHub) return -1;
			if (!a.isHub && b.isHub) return 1;
			return b.degree - a.degree;
		});

		const spawnSpeed = Math.max(1, tempNodes.length / GRAPH_CONSTANTS.PHYSICS.WAVE_DURATION_FRAMES);

		tempNodes.forEach((node, index) => {
			node.spawnFrame = Math.floor(index / spawnSpeed);
			this.nodes.push(node);
			nodeIndexMap.set(node.id, index);
		});

		for (const [path, neighbors] of graphMap.entries()) {
			const sourceIndex = nodeIndexMap.get(path);
			if (sourceIndex === undefined) continue;
			for (const neighbor of neighbors) {
				const targetIndex = nodeIndexMap.get(neighbor);
				if (targetIndex !== undefined && sourceIndex < targetIndex) {
					this.edges.push({ sourceIndex, targetIndex, hoverProgress: 0, visualOpacity: 0, visualWidth: 0 });
				}
			}
		}

		if (s.spawnAnimation === 'radial') {
			for (const node of this.nodes) node.isActive = true; 
			for (let i = 0; i < 200; i++) this.stepPhysics(true); 

			for (const node of this.nodes) {
				node.targetX = node.x; node.targetY = node.y;
				const scatterAngle = Math.random() * Math.PI * 2;
				const scatterDist = Math.random() * 150 + 50; 
				node.x = node.targetX + Math.cos(scatterAngle) * scatterDist;
				node.y = node.targetY + Math.sin(scatterAngle) * scatterDist;
				node.isActive = false; 
			}
		}

		this.wakeUp(); 
	}

	startSimulation() {
		const tick = () => {
			this.updatePhysics();
			this.drawGraph();
			this.animationFrameId = requestAnimationFrame(tick);
		};
		tick();
	}

	updatePhysics() {
		this.currentFrame++;
		const s = this.plugin.settings.globalGraph;

		let activeNodesCount = 0;
		for (const node of this.nodes) {
			if (s.spawnAnimation === 'radial' || this.currentFrame >= node.spawnFrame) node.isActive = true; 
			if (node.isActive) activeNodesCount++;
		}

		this.isFullySpawned = activeNodesCount === this.nodes.length;

		if (this.isSleeping) return;

		this.transform.k += (this.targetTransform.k - this.transform.k) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
		this.transform.x += (this.targetTransform.x - this.transform.x) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
		this.transform.y += (this.targetTransform.y - this.transform.y) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;

		let totalVelocity = 0;

		if (!this.isFullySpawned && s.spawnAnimation === 'radial') {
			for (const node of this.nodes) {
				if (!node.isActive || node === this.draggedNode) continue;
				const diffX = node.targetX - node.x; const diffY = node.targetY - node.y;
				node.x += diffX * 0.15; node.y += diffY * 0.15;
				totalVelocity += Math.abs(diffX) + Math.abs(diffY);
			}
		} else {
			totalVelocity = this.stepPhysics(false); 
		}

		const averageVelocity = activeNodesCount > 0 ? totalVelocity / activeNodesCount : 0;

		if (this.isFullySpawned && averageVelocity < GRAPH_CONSTANTS.PHYSICS.SLEEP_VELOCITY_THRESHOLD) { 
			this.energy *= GRAPH_CONSTANTS.PHYSICS.ENERGY_DECAY;
			if (this.energy < 0.05) {
				this.stableFrames++;
				if (this.stableFrames > GRAPH_CONSTANTS.PHYSICS.SLEEP_FRAME_THRESHOLD) { 
					this.isSleeping = true; this.energy = 0;
					for (const node of this.nodes) { node.vx = 0; node.vy = 0; }
				}
			}
		} else {
			this.stableFrames = 0;
			if (this.draggedNode) this.energy = 1.0;
			else this.energy = Math.min(1.0, this.energy + 0.05);
		}
	}

	drawGraph() {
		if (!this.ctx || !this.canvas) return;
		
		const s = this.plugin.settings.globalGraph;
		
		this.ctx.imageSmoothingEnabled = true;
		this.ctx.imageSmoothingQuality = "high";
		
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		const dpr = window.devicePixelRatio || 1;
		this.ctx.scale(dpr, dpr); 
		
		this.ctx.translate(this.transform.x, this.transform.y);
		this.ctx.scale(this.transform.k, this.transform.k);

		const leftLimit = -this.transform.x / this.transform.k;
		const rightLimit = (this.canvas.width / dpr - this.transform.x) / this.transform.k;
		const topLimit = -this.transform.y / this.transform.k;
		const bottomLimit = (this.canvas.height / dpr - this.transform.y) / this.transform.k;

		this.ctx.textAlign = "center";
		this.ctx.textBaseline = "middle";

		const connectedNodes = new Set<any>();
		const groupHighlightedNodes = new Set<any>();

		if (this.hoveredNode && this.hoveredNode.isActive) {
			connectedNodes.add(this.hoveredNode);
			for (const edge of this.edges) {
				const n1 = this.nodes[edge.sourceIndex]; const n2 = this.nodes[edge.targetIndex];
				if (n1 === this.hoveredNode) connectedNodes.add(n2);
				if (n2 === this.hoveredNode) connectedNodes.add(n1);
			}
			if (this.hoveredNode.primaryCluster) {
				for (const node of this.nodes) {
					if (node !== this.hoveredNode && node.primaryCluster === this.hoveredNode.primaryCluster && !node.isAbsoluteCenter) {
						groupHighlightedNodes.add(node);
					}
				}
			}
		}

		const lerp = (start: number, end: number, factor: number) => start + (end - start) * factor;
		const visFactor = GRAPH_CONSTANTS.VISUALS.VISUAL_LERP_SPEED;
		
		const waveRadius = Math.max(0, this.currentFrame - GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE_DELAY) * GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE_SPEED;
		const waveRadiusSq = waveRadius * waveRadius; 

		for (const node of this.nodes) {
			let isVisuallyActive = true; let w1Glow = 0; let w2Glow = 0;

			if (s.spawnAnimation === 'hierarchical') {
				isVisuallyActive = node.isActive;
			} else {
				const distSqFromCenter = node.x * node.x + node.y * node.y;
				isVisuallyActive = distSqFromCenter <= waveRadiusSq;

				if (isVisuallyActive && s.enableGlow) {
					const distFromCenter = Math.sqrt(distSqFromCenter);
					const distBehindFront1 = waveRadius - distFromCenter;
					if (distBehindFront1 >= 0 && distBehindFront1 < GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE1_THICKNESS) {
						const prog1 = 1 - (distBehindFront1 / GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE1_THICKNESS);
						w1Glow = Math.sin(prog1 * Math.PI); 
					}
					const distBehindFront2 = Math.max(0, waveRadius - GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE2_OFFSET) - distFromCenter;
					if (distBehindFront2 >= 0 && distBehindFront2 < GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE2_THICKNESS) {
						const prog2 = 1 - (distBehindFront2 / GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE2_THICKNESS);
						w2Glow = Math.sin(prog2 * Math.PI); 
					}
				}
			}

			if (!isVisuallyActive) {
				node.visualRadius = 0; node.visualOpacity = 0; node.visualGlow = 0; node.visualTextOpacity = 0;
				node.waveGlow1 = 0; node.waveGlow2 = 0;
				continue; 
			}

			node.waveGlow1 = w1Glow * s.glowIntensity;
			node.waveGlow2 = w2Glow * s.glowIntensity;

			const isHovered = this.hoveredNode === node;
			const isConnectedToHover = this.hoveredNode ? connectedNodes.has(node) : true;
			const isGroupHighlight = groupHighlightedNodes.has(node);

			let targetRadius = node.radius;
			if (isHovered) targetRadius = node.radius * GRAPH_CONSTANTS.VISUALS.NODE_HOVER_SCALE;
			else if (isGroupHighlight) targetRadius = node.radius * GRAPH_CONSTANTS.VISUALS.NODE_GROUP_HIGHLIGHT_SCALE;

			let targetOpacity = GRAPH_CONSTANTS.VISUALS.OPACITY_UNFOCUSED_NODE;
			if (isConnectedToHover) targetOpacity = 1.0;
			else if (isGroupHighlight) targetOpacity = 0.7; // Visual Dimming per il gruppo non puntato

			if (s.spawnAnimation === 'radial' && (w1Glow > 0.05 || w2Glow > 0.05)) targetOpacity = 1.0; 

			let targetGlow = 0;
			if (s.enableGlow) {
				if (node.isAbsoluteCenter) targetGlow = GRAPH_CONSTANTS.VISUALS.CENTER_GLOW_BLUR * s.glowIntensity;
				else if (isGroupHighlight && node.primaryColor) targetGlow = GRAPH_CONSTANTS.VISUALS.GROUP_HIGHLIGHT_GLOW_BLUR * s.glowIntensity;
			}

			let targetTextOpacity = 1.0;
			const threshold = s.labelVisibilityThreshold;
			if (!s.showAllLabels && !isHovered && !isGroupHighlight && threshold > 0) {
				const fadeStart = threshold; const fadeEnd = threshold * 0.4;
				targetTextOpacity = Math.max(0, Math.min(1, (this.transform.k - fadeEnd) / (fadeStart - fadeEnd)));
			}
			targetTextOpacity *= targetOpacity;

			node.visualRadius = lerp(node.visualRadius, targetRadius, visFactor);
			node.visualOpacity = lerp(node.visualOpacity, targetOpacity, visFactor);
			node.visualGlow = lerp(node.visualGlow, targetGlow, visFactor);
			node.visualTextOpacity = lerp(node.visualTextOpacity, targetTextOpacity, visFactor);
		}

		for (const edge of this.edges) {
			const n1 = this.nodes[edge.sourceIndex]; const n2 = this.nodes[edge.targetIndex];

			let isLinkVisuallyActive = true;
			if (s.spawnAnimation === 'hierarchical') {
				isLinkVisuallyActive = n1.isActive && n2.isActive;
			} else {
				const dist1Sq = n1.x * n1.x + n1.y * n1.y; const dist2Sq = n2.x * n2.x + n2.y * n2.y;
				const waveSq = waveRadius * waveRadius;
				isLinkVisuallyActive = (dist1Sq <= waveSq) && (dist2Sq <= waveSq);
			}

			if (!isLinkVisuallyActive) {
				edge.visualOpacity = 0; edge.visualWidth = 0; continue;
			}
			
			const isHovered = this.hoveredNode === n1 || this.hoveredNode === n2;
			const isGroupLink = this.hoveredNode && n1.primaryCluster === this.hoveredNode.primaryCluster && n2.primaryCluster === this.hoveredNode.primaryCluster && this.hoveredNode.primaryCluster !== "";

			edge.hoverProgress = isHovered ? Math.min(1.0, edge.hoverProgress + GRAPH_CONSTANTS.VISUALS.HOVER_FADE_IN_SPEED) : Math.max(0.0, edge.hoverProgress - GRAPH_CONSTANTS.VISUALS.HOVER_FADE_OUT_SPEED); 

			let targetOpacity = GRAPH_CONSTANTS.VISUALS.OPACITY_BASE_LINK;
			let targetWidth = s.linkWidthBase;

			if (isGroupLink) {
				targetOpacity = GRAPH_CONSTANTS.VISUALS.OPACITY_GROUP_HIGHLIGHT_LINK;
				targetWidth = s.linkWidthBase * 1.5;
			} else if (this.hoveredNode && !isHovered) {
				targetOpacity = GRAPH_CONSTANTS.VISUALS.OPACITY_UNFOCUSED_LINK;
			}

			edge.visualOpacity = lerp(edge.visualOpacity, targetOpacity, visFactor);
			edge.visualWidth = lerp(edge.visualWidth, targetWidth, visFactor);
			
			const n1Off = n1.x < leftLimit || n1.x > rightLimit || n1.y < topLimit || n1.y > bottomLimit;
			const n2Off = n2.x < leftLimit || n2.x > rightLimit || n2.y < topLimit || n2.y > bottomLimit;
			if (n1Off && n2Off) continue;

			this.ctx.beginPath();
			this.ctx.moveTo(n1.x, n1.y);
			this.ctx.lineTo(n2.x, n2.y);
			
			if (isGroupLink) {
				this.ctx.strokeStyle = s.enableColors ? (n1.primaryColor || "rgba(150, 150, 150, 0.4)") : "rgba(150, 150, 150, 0.6)";
			} else {
				this.ctx.strokeStyle = `rgba(150, 150, 150, 1.0)`; 
			}
			
			this.ctx.globalAlpha = edge.visualOpacity;
			this.ctx.lineWidth = edge.visualWidth / this.transform.k;
			this.ctx.stroke();

			if (edge.hoverProgress > 0) {
				this.ctx.save();
				this.ctx.beginPath(); this.ctx.moveTo(n1.x, n1.y); this.ctx.lineTo(n2.x, n2.y);
				this.ctx.globalAlpha = edge.hoverProgress * edge.visualOpacity; 
				this.ctx.strokeStyle = this.resolvedHoverColor;
				this.ctx.lineWidth = s.linkWidthHover / this.transform.k;
				this.ctx.stroke(); this.ctx.restore();
			}
		}

		this.ctx.globalAlpha = 1.0; 

		const renderNode = (node: any, isHovered: boolean, isGroupHighlight: boolean) => {
			const currentRadius = node.visualRadius + (node.radius * (node.waveGlow1 || 0) * 0.25);
			if (currentRadius < 0.1) return;
			if (node.x < leftLimit - currentRadius * 3 || node.x > rightLimit + currentRadius * 3 || node.y < topLimit - currentRadius * 3 || node.y > bottomLimit + currentRadius * 3) return;

			const activeNodeColor = s.enableColors ? node.color : GRAPH_CONSTANTS.COLORS.DEFAULT_NODE;
			const activePrimaryColor = s.enableColors ? node.primaryColor : undefined;
			const isWaveActive = s.spawnAnimation === 'radial' && (node.waveGlow1 > 0 || node.waveGlow2 > 0);

			this.ctx.globalAlpha = node.visualOpacity;
			
			if (isWaveActive) {
				this.ctx.save();
				if (node.waveGlow1 > 0.01) {
					this.ctx.fillStyle = activePrimaryColor || activeNodeColor;
					const numLayers = 4; 
					const spread = 40 * node.waveGlow1;
					for (let l = 1; l <= numLayers; l++) {
						this.ctx.globalAlpha = node.visualOpacity * node.waveGlow1 * (0.6 / Math.pow(2, l));
						this.ctx.beginPath();
						this.ctx.arc(node.x, node.y, currentRadius + (spread * (l / numLayers)), 0, 2 * Math.PI, false);
						this.ctx.fill();
					}
				}

				if (node.waveGlow2 > 0.01) {
					this.ctx.globalAlpha = node.visualOpacity * node.waveGlow2 * 0.8;
					this.ctx.fillStyle = '#ffffff'; 
					this.ctx.beginPath(); this.ctx.arc(node.x, node.y, currentRadius + 8 * node.waveGlow2, 0, 2 * Math.PI, false); this.ctx.fill();
				}
				this.ctx.restore();
			} 

			this.ctx.save();
			this.ctx.globalAlpha = node.visualOpacity;
			
			if (!isWaveActive && node.visualGlow > 0.1) {
				if (node.isAbsoluteCenter) {
					this.ctx.shadowBlur = node.visualGlow;
					this.ctx.shadowColor = s.enableColors ? GRAPH_CONSTANTS.COLORS.CENTER_GLOW : 'rgba(150,150,150,0.8)';
				} else if (activePrimaryColor) {
					this.ctx.shadowBlur = node.visualGlow;
					this.ctx.shadowColor = activePrimaryColor;
				}
			}

			this.ctx.beginPath();
			this.ctx.arc(node.x, node.y, currentRadius, 0, 2 * Math.PI, false);
			this.ctx.fillStyle = node.isAbsoluteCenter ? (s.enableColors ? GRAPH_CONSTANTS.COLORS.CENTER_NODE : GRAPH_CONSTANTS.COLORS.DEFAULT_NODE) : activeNodeColor;
			this.ctx.fill();

			if (node.isAbsoluteCenter && s.enableGlow) {
				this.ctx.strokeStyle = s.enableColors ? GRAPH_CONSTANTS.COLORS.CENTER_BORDER : 'rgba(150,150,150,0.6)';
				this.ctx.lineWidth = 3 / this.transform.k;
				this.ctx.stroke();
			}
			this.ctx.restore();
			
			if (node.visualTextOpacity > 0.01) {
				this.ctx.globalAlpha = node.visualTextOpacity;
				
				let fontColorHex = "#ffffff";
				let fontStyleSet = "normal";

				if (node.isAbsoluteCenter) {
					fontColorHex = s.centerNodeMatchColor ? (activePrimaryColor || activeNodeColor) : s.centerNodeFontColor;
					fontStyleSet = s.centerNodeFontStyle;
				} else if (node.isHub) {
					fontColorHex = s.hubNodeMatchColor ? (activePrimaryColor || activeNodeColor) : s.hubNodeFontColor;
					fontStyleSet = s.hubNodeFontStyle;
				} else {
					fontColorHex = s.standardNodeMatchColor ? (activePrimaryColor || activeNodeColor) : s.standardNodeFontColor;
					fontStyleSet = s.standardNodeFontStyle;
				}

				let fillStyle = this.resolveCSSColor(fontColorHex, "#ffffff");
				if (isHovered || isGroupHighlight) fillStyle = "#ffffff"; 

				let baseFontSize = node.isAbsoluteCenter ? (s.fontSizeMax + 2) : Math.max(s.fontSizeMin, Math.min(s.fontSizeMax, node.radius)); 
				const fontStringRaw = this.getFontString(fontStyleSet, baseFontSize);

				if (isHovered) {
					const scaledUpSize = baseFontSize * GRAPH_CONSTANTS.VISUALS.TEXT_HOVER_SCALE;
					const minScreenSizeInCanvasUnits = GRAPH_CONSTANTS.VISUALS.MIN_HOVER_TEXT_SIZE_SCREEN / this.transform.k;
					baseFontSize = Math.max(scaledUpSize, minScreenSizeInCanvasUnits);
					const yPosHover = node.y - currentRadius - (GRAPH_CONSTANTS.VISUALS.TEXT_PADDING / this.transform.k);
					
					this.ctx.font = this.getFontString(fontStyleSet, baseFontSize);
					const textWidth = this.ctx.measureText(node.name).width;
					
					// Disegna il badge scuro dietro al testo in hover
					const padX = 8 / this.transform.k;
					const padY = 4 / this.transform.k;
					this.ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
					this.ctx.beginPath();
					this.ctx.roundRect(node.x - textWidth/2 - padX, yPosHover - baseFontSize/2 - padY, textWidth + padX*2, baseFontSize + padY*2, 4 / this.transform.k);
					this.ctx.fill();

					this.ctx.fillStyle = fillStyle;
					this.ctx.fillText(node.name, node.x, yPosHover);
				} else {
					const yPos = node.y - currentRadius - GRAPH_CONSTANTS.VISUALS.TEXT_PADDING;
					const scaleLevel = Math.max(1, Math.min(Math.ceil(this.transform.k), 5)); 
					const textCanvas = this.getTextCanvas(node.name, fontStringRaw, baseFontSize, fillStyle, scaleLevel);
					
					const dprMultiplier = (window.devicePixelRatio || 1) * scaleLevel * 4.0;
					const logicalWidth = textCanvas.width / dprMultiplier;
					const logicalHeight = textCanvas.height / dprMultiplier;
					
					this.ctx.drawImage(textCanvas, node.x - logicalWidth / 2, yPos - logicalHeight / 2, logicalWidth, logicalHeight);
				}
			}
			this.ctx.globalAlpha = 1.0; 
		};

		for (const node of this.nodes) if (node !== this.hoveredNode && !groupHighlightedNodes.has(node)) renderNode(node, false, false);
		for (const node of groupHighlightedNodes) renderNode(node, false, true);
		if (this.hoveredNode) renderNode(this.hoveredNode, true, false);

		this.ctx.restore();
	}
}

// ---------------------------------------------------------
// 7. LOCAL GRAPH RENDERER ENGINE (Reusable)
// ---------------------------------------------------------

class SmartLocalGraphRenderer {
	container: HTMLElement;
	file: TFile;
	plugin: SmartGraphPlugin;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	animationFrameId: number = 0;
	isStandalone: boolean;
	
	nodes: any[] = [];
	edges: any[] = [];

	transform = { x: 0, y: 0, k: 1 };
	targetTransform = { x: 0, y: 0, k: 1 };

	isDragging = false;
	dragStartX = 0;
	dragStartY = 0;
	rawDragStartX = 0;
	rawDragStartY = 0;
	draggedNode: any = null;
	hoveredNode: any = null; 

	isSleeping: boolean = false;
	stableFrames: number = 0;
	energy: number = 1.0; 
	isFirstRender: boolean = true; 

	textCache: Map<string, HTMLCanvasElement> = new Map();

	boundMouseMove: (e: MouseEvent) => void;
	boundMouseUp: (e: MouseEvent) => void;

	constructor(container: HTMLElement, file: TFile, plugin: SmartGraphPlugin, isStandalone: boolean) {
		this.container = container;
		this.file = file;
		this.plugin = plugin;
		this.isStandalone = isStandalone;

		this.boundMouseMove = (e: MouseEvent) => this.handleGlobalMouseMove(e);
		this.boundMouseUp = (e: MouseEvent) => this.handleGlobalMouseUp(e);

		this.canvas = document.createElement('canvas');
		this.canvas.style.display = 'block';
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		this.canvas.style.backgroundColor = 'transparent';
		this.container.appendChild(this.canvas);
		this.ctx = this.canvas.getContext('2d', { alpha: true })!;

		this.buildOverlayUI();

		const resizeObserver = new ResizeObserver(() => {
			const dpr = window.devicePixelRatio || 1;
			const rect = this.container.getBoundingClientRect();
			this.canvas.width = rect.width * dpr;
			this.canvas.height = rect.height * dpr;

			if (this.transform.x === 0 && this.transform.y === 0) {
				this.transform.x = rect.width / 2;
				this.transform.y = rect.height / 2;
				this.transform.k = 1.0; 
				this.targetTransform = { ...this.transform };
			}
			this.wakeUp();
		});
		resizeObserver.observe(this.container);

		this.initData();
		this.setupInteraction();
		this.startSimulation();
	}

	resolveCSSColor(cssVar: string, fallback: string): string {
		if (cssVar && cssVar.startsWith('var(')) {
			const varName = cssVar.slice(4, -1).trim();
			const color = getComputedStyle(document.body).getPropertyValue(varName).trim();
			return color ? color : fallback;
		}
		return cssVar || fallback;
	}

	getFontString(styleSetting: string, size: number) {
		let style = "normal";
		let weight = "400";
		if (styleSetting === "bold") weight = "700";
		if (styleSetting === "italic") style = "italic";
		if (styleSetting === "bold-italic") { style = "italic"; weight = "700"; }
		return `${style} ${weight} ${size}px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
	}

	getTextCanvas(text: string, fontString: string, fontSize: number, color: string, scaleLevel: number): HTMLCanvasElement {
		const safeScale = Math.min(Math.max(1, Math.ceil(scaleLevel)), 5); 
		const key = `${text}_${fontString}_${color}_${safeScale}`;
		let cached = this.textCache.get(key);
		if (cached) return cached;

		const offscreenCanvas = document.createElement('canvas');
		const offscreenCtx = offscreenCanvas.getContext('2d')!;
		
		const SUPER_SAMPLE = 4.0; 
		const baseDpr = window.devicePixelRatio || 1;
		const dpr = baseDpr * safeScale * SUPER_SAMPLE; 
		
		offscreenCtx.font = fontString;
		const textWidth = Math.ceil(offscreenCtx.measureText(text).width);
		
		const logicalWidth = textWidth + GRAPH_CONSTANTS.VISUALS.TEXT_PADDING * 2.0;
		const logicalHeight = fontSize + GRAPH_CONSTANTS.VISUALS.TEXT_PADDING * 2.0;
		
		offscreenCanvas.width = logicalWidth * dpr;
		offscreenCanvas.height = logicalHeight * dpr;
		offscreenCtx.scale(dpr, dpr);
		
		offscreenCtx.font = fontString;
		offscreenCtx.fillStyle = color;
		offscreenCtx.textAlign = 'center';
		offscreenCtx.textBaseline = 'middle';
		
		offscreenCtx.shadowColor = "rgba(0,0,0,0.8)";
		offscreenCtx.shadowBlur = 5;
		
		offscreenCtx.fillText(text, logicalWidth / 2, logicalHeight / 2);
		
		this.textCache.set(key, offscreenCanvas);
		return offscreenCanvas;
	}

	buildOverlayUI() {
		const overlayWrapper = document.createElement('div');
		overlayWrapper.style.position = 'absolute';
		overlayWrapper.style.top = '10px';
		overlayWrapper.style.right = '10px'; 
		overlayWrapper.style.display = 'flex';
		overlayWrapper.style.gap = '8px';
		overlayWrapper.style.zIndex = '10';

		const expandBtn = document.createElement('div');
		if (!this.isStandalone) {
			expandBtn.style.cursor = 'pointer';
			expandBtn.style.padding = '6px';
			expandBtn.style.color = 'var(--text-muted)';
			expandBtn.style.transition = 'color 0.2s';
			setIcon(expandBtn, 'maximize');
			expandBtn.title = 'Open as Floating Window';
			expandBtn.addEventListener('mouseenter', () => { expandBtn.style.color = 'var(--text-normal)'; });
			expandBtn.addEventListener('mouseleave', () => { expandBtn.style.color = 'var(--text-muted)'; });
			expandBtn.addEventListener('click', () => {
				this.plugin.toggleFloatingLocalGraph();
			});
			overlayWrapper.appendChild(expandBtn);
		}

		const toggleBtn = document.createElement('div');
		toggleBtn.style.cursor = 'pointer';
		toggleBtn.style.padding = '6px';
		toggleBtn.style.color = 'var(--text-muted)';
		toggleBtn.style.transition = 'color 0.2s';
		setIcon(toggleBtn, 'settings');
		toggleBtn.title = 'Local Graph Settings';
		toggleBtn.addEventListener('mouseenter', () => { toggleBtn.style.color = 'var(--text-normal)'; });
		toggleBtn.addEventListener('mouseleave', () => { toggleBtn.style.color = 'var(--text-muted)'; });
		
		const uiPanel = document.createElement('div');
		uiPanel.style.position = 'absolute';
		uiPanel.style.top = '0';
		uiPanel.style.right = '0';
		uiPanel.style.backgroundColor = 'var(--background-secondary)';
		uiPanel.style.border = '1px solid var(--background-modifier-border)';
		uiPanel.style.borderRadius = 'var(--radius-m)';
		uiPanel.style.display = 'none'; 
		uiPanel.style.flexDirection = 'column';
		uiPanel.style.boxShadow = 'var(--shadow-s)';
		uiPanel.style.width = '320px'; 
		uiPanel.style.maxHeight = 'calc(100% - 20px)'; 
		uiPanel.style.overflow = 'hidden';
		uiPanel.style.zIndex = '100';

		toggleBtn.addEventListener('click', () => {
			toggleBtn.style.display = 'none';
			if (!this.isStandalone) expandBtn.style.display = 'none';
			uiPanel.style.display = 'flex';
		});

		const header = document.createElement('div');
		header.style.display = 'flex';
		header.style.justifyContent = 'space-between';
		header.style.alignItems = 'center';
		header.style.padding = '12px 16px';
		header.style.backgroundColor = 'rgba(0,0,0,0.1)';
		header.style.borderBottom = '1px solid var(--background-modifier-border)';
		
		const title = document.createElement('div');
		title.textContent = 'Graph Options (Local)';
		title.style.fontWeight = '600';
		title.style.color = 'var(--text-normal)';
		header.appendChild(title);

		const headerIcons = document.createElement('div');
		headerIcons.style.display = 'flex';
		headerIcons.style.gap = '12px';
		headerIcons.style.alignItems = 'center';

		const syncBtn = document.createElement('div');
		syncBtn.style.cursor = 'pointer';
		syncBtn.style.color = 'var(--text-muted)';
		setIcon(syncBtn, 'rotate-ccw'); 
		syncBtn.title = 'Sync with Global Defaults';
		syncBtn.addEventListener('mouseenter', () => { syncBtn.style.color = 'var(--text-normal)'; });
		syncBtn.addEventListener('mouseleave', () => { syncBtn.style.color = 'var(--text-muted)'; });
		
		const closeBtn = document.createElement('div');
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.color = 'var(--text-muted)';
		setIcon(closeBtn, 'x'); 
		closeBtn.title = 'Close Menu';
		closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'var(--text-normal)'; });
		closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'var(--text-muted)'; });
		closeBtn.addEventListener('click', () => { 
			uiPanel.style.display = 'none'; 
			toggleBtn.style.display = 'block';
			if (!this.isStandalone) expandBtn.style.display = 'block';
		});
		
		headerIcons.appendChild(syncBtn);
		headerIcons.appendChild(closeBtn);
		header.appendChild(headerIcons);
		uiPanel.appendChild(header);

		const contentContainer = document.createElement('div');
		contentContainer.style.overflowY = 'auto';
		const contentBody = document.createElement('div');
		contentBody.style.display = 'flex';
		contentBody.style.flexDirection = 'column';
		contentBody.style.gap = '16px';
		contentBody.style.padding = '16px';

		const createSection = (titleText: string, defaultOpen: boolean = true) => {
			const sectionWrapper = document.createElement('div');
			sectionWrapper.style.borderBottom = '1px solid var(--background-modifier-border)';
			
			const sectionHeader = document.createElement('div');
			sectionHeader.style.display = 'flex';
			sectionHeader.style.alignItems = 'center';
			sectionHeader.style.justifyContent = 'space-between';
			sectionHeader.style.padding = '8px 12px';
			sectionHeader.style.cursor = 'pointer';
			sectionHeader.style.color = 'var(--text-muted)';
			sectionHeader.style.fontSize = '11px';
			sectionHeader.style.fontWeight = '600';
			sectionHeader.style.textTransform = 'uppercase';
			
			const titleObj = document.createElement('span');
			titleObj.textContent = titleText;
			sectionHeader.appendChild(titleObj);
			
			const chevron = document.createElement('span');
			setIcon(chevron, 'chevron-down');
			chevron.style.transition = 'transform 0.2s';
			chevron.style.width = '14px';
			chevron.style.height = '14px';
			sectionHeader.appendChild(chevron);

			const content = document.createElement('div');
			content.style.display = defaultOpen ? 'flex' : 'none';
			content.style.flexDirection = 'column';
			content.style.gap = '14px';
			content.style.padding = '12px';
			
			if(!defaultOpen) chevron.style.transform = 'rotate(-90deg)';

			sectionHeader.addEventListener('click', () => {
				const isOpen = content.style.display === 'flex';
				content.style.display = isOpen ? 'none' : 'flex';
				chevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
			});

			sectionWrapper.appendChild(sectionHeader);
			sectionWrapper.appendChild(content);
			contentBody.appendChild(sectionWrapper);
			return content;
		};

		const createSelect = (parent: HTMLElement, name: string, options: Record<string, string>, value: string, onChange: (val: string) => void) => {
			const wrapper = document.createElement('div');
			wrapper.style.display = 'flex';
			wrapper.style.justifyContent = 'space-between';
			wrapper.style.alignItems = 'center';
			
			const label = document.createElement('label');
			label.textContent = name;
			label.style.fontSize = 'var(--font-ui-small)';
			label.style.color = 'var(--text-normal)';

			const select = document.createElement('select');
			select.className = 'dropdown';
			select.style.maxWidth = '140px';
			select.style.backgroundColor = 'var(--background-modifier-form-field)';
			select.style.border = '1px solid var(--background-modifier-border)';
			select.style.color = 'var(--text-normal)';
			select.style.borderRadius = 'var(--radius-s)';
			
			for (const key of Object.keys(options)) {
				const option = document.createElement('option');
				option.textContent = options[key];
				option.value = key;
				if (key === value) option.selected = true;
				select.appendChild(option);
			}

			select.addEventListener('change', async (e) => {
				onChange((e.target as HTMLSelectElement).value);
			});
			
			wrapper.appendChild(label);
			wrapper.appendChild(select);
			parent.appendChild(wrapper);
		};

		const createTextInput = (parent: HTMLElement, name: string, placeholder: string, value: string, onChange: (val: string) => void) => {
			const wrapper = document.createElement('div');
			wrapper.style.display = 'flex';
			wrapper.style.flexDirection = 'column';
			wrapper.style.gap = '6px';
			
			const label = document.createElement('label');
			label.textContent = name;
			label.style.fontSize = 'var(--font-ui-small)';
			label.style.color = 'var(--text-normal)';

			const input = document.createElement('input');
			input.type = 'text';
			input.value = value;
			input.placeholder = placeholder;
			input.style.width = '100%';
			input.style.backgroundColor = 'var(--background-modifier-form-field)';
			input.style.border = '1px solid var(--background-modifier-border)';
			input.style.color = 'var(--text-normal)';
			input.style.padding = '4px 8px';
			input.style.borderRadius = 'var(--radius-s)';

			input.addEventListener('change', async (e) => {
				onChange((e.target as HTMLInputElement).value);
			});

			wrapper.appendChild(label);
			wrapper.appendChild(input);
			parent.appendChild(wrapper);
		};

		const createSlider = (parent: HTMLElement, name: string, min: number, max: number, step: number, value: number, onChange: (val: number) => void) => {
			const wrapper = document.createElement('div');
			wrapper.style.display = 'flex';
			wrapper.style.flexDirection = 'column';
			wrapper.style.gap = '6px';
			
			const labelRow = document.createElement('div');
			labelRow.style.display = 'flex';
			labelRow.style.justifyContent = 'space-between';
			
			const label = document.createElement('label');
			label.textContent = name;
			label.style.fontSize = 'var(--font-ui-small)';
			
			const valDisplay = document.createElement('span');
			valDisplay.textContent = value.toString();
			valDisplay.style.fontSize = 'var(--font-ui-small)';
			valDisplay.style.color = 'var(--text-muted)';

			labelRow.appendChild(label);
			labelRow.appendChild(valDisplay);
			wrapper.appendChild(labelRow);

			const slider = document.createElement('input');
			slider.type = 'range';
			slider.className = 'slider'; 
			slider.min = min.toString();
			slider.max = max.toString();
			slider.step = step.toString();
			slider.value = value.toString();
			slider.style.width = '100%';
			
			slider.addEventListener('input', (e) => {
				const newVal = parseFloat((e.target as HTMLInputElement).value);
				valDisplay.innerText = newVal.toString();
				onChange(newVal);
			});
			wrapper.appendChild(slider);
			parent.appendChild(wrapper);
		};

		const createToggle = (parent: HTMLElement, name: string, value: boolean, onChange: (val: boolean) => void) => {
			const wrapper = document.createElement('div');
			wrapper.style.display = 'flex';
			wrapper.style.justifyContent = 'space-between';
			wrapper.style.alignItems = 'center';
			
			const label = document.createElement('label');
			label.textContent = name;
			label.style.fontSize = 'var(--font-ui-small)';
			wrapper.appendChild(label);

			const toggleContainer = document.createElement('div');
			toggleContainer.className = 'checkbox-container'; 
			if(value) toggleContainer.classList.add('is-enabled');

			toggleContainer.addEventListener('click', async () => {
				const isEnabled = toggleContainer.classList.contains('is-enabled');
				if(isEnabled) toggleContainer.classList.remove('is-enabled');
				else toggleContainer.classList.add('is-enabled');
				onChange(!isEnabled);
			});
			wrapper.appendChild(toggleContainer);
			parent.appendChild(wrapper);
		};

		const renderControls = () => {
			contentBody.empty();
			const s = this.plugin.settings.localGraph;

			const typographySection = createSection('Typography', true);
			const fontStyleOptions = { 'normal': 'Normal', 'bold': 'Bold', 'italic': 'Italic', 'bold-italic': 'Bold Italic' };
			
			createSelect(typographySection, 'Absolute Center Style', fontStyleOptions, s.centerNodeFontStyle, async (val) => {
				s.centerNodeFontStyle = val as any; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
			});
			createToggle(typographySection, 'Center Match Node Color', s.centerNodeMatchColor, async (val) => {
				s.centerNodeMatchColor = val; this.textCache.clear(); await this.plugin.saveSettings(false); renderControls(); this.drawGraph();
			});
			if (!s.centerNodeMatchColor) {
				createTextInput(typographySection, 'Absolute Center Color', '#ffffff', s.centerNodeFontColor, async (val) => {
					s.centerNodeFontColor = val; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
				});
			}

			const appearanceSection = createSection('Appearance', false);
			createToggle(appearanceSection, 'Enable Node Colors', s.enableColors, async (val) => {
				s.enableColors = val; await this.plugin.saveSettings(false); this.drawGraph();
			});
			createToggle(appearanceSection, 'Enable Glow Effects', s.enableGlow, async (val) => {
				s.enableGlow = val; await this.plugin.saveSettings(false); this.drawGraph();
			});
			createSlider(appearanceSection, 'Glow Intensity', 0.1, 3.0, 0.1, s.glowIntensity, async (val) => {
				s.glowIntensity = val; await this.plugin.saveSettings(false); this.drawGraph();
			});
			createSlider(appearanceSection, 'Node Min Size', 1, 10, 1, s.nodeMinRadius, async (val) => {
				s.nodeMinRadius = val; this.initData(); await this.plugin.saveSettings(false);
			});
			createSlider(appearanceSection, 'Node Max Size', 10, 50, 1, s.nodeMaxRadius, async (val) => {
				s.nodeMaxRadius = val; this.initData(); await this.plugin.saveSettings(false);
			});
			createSlider(appearanceSection, 'Font Size Base', 6, 24, 1, s.fontSizeMin, async (val) => {
				s.fontSizeMin = val; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
			});
			createSlider(appearanceSection, 'Font Size Max', 10, 36, 1, s.fontSizeMax, async (val) => {
				s.fontSizeMax = val; this.textCache.clear(); await this.plugin.saveSettings(false); this.drawGraph();
			});
			createSlider(appearanceSection, 'Link Base Thickness', 0.1, 3.0, 0.1, s.linkWidthBase, async (val) => {
				s.linkWidthBase = val; await this.plugin.saveSettings(false); this.drawGraph();
			});

			const forceSection = createSection('Forces', false);
			createSlider(forceSection, 'Repel Force', 0, 15000, 100, s.repulsionForce, async (val) => {
				s.repulsionForce = val; await this.plugin.saveSettings(false); this.wakeUp();
			});
			createSlider(forceSection, 'Link Distance', 10, 500, 5, s.linkDistance, async (val) => {
				s.linkDistance = val; await this.plugin.saveSettings(false); this.wakeUp();
			});
		};

		renderControls();

		syncBtn.addEventListener('click', async () => {
			this.plugin.settings.localGraph = JSON.parse(JSON.stringify(this.plugin.settings.globalDefaults));
			await this.plugin.saveSettings(false);
			this.initData();
			renderControls();
			this.drawGraph();
		});

		contentContainer.appendChild(contentBody);
		uiPanel.appendChild(contentContainer);
		
		overlayWrapper.appendChild(toggleBtn);
		this.container.appendChild(uiPanel);
		this.container.appendChild(overlayWrapper);
	}

	initData() {
		const s = this.plugin.settings.localGraph;
		const graphMap = this.plugin.buildBidirectionalGraph();
		const neighbors = graphMap.get(this.file.path) || new Set();
		const localNodesSet = new Set([this.file.path, ...neighbors]);
		const nodeIndexMap = new Map<string, number>();

		let maxDegreeLocal = 1;
		for (const path of localNodesSet) {
			let localLinks = 0;
			const pathNeighbors = graphMap.get(path) || new Set();
			for(const n of pathNeighbors) if(localNodesSet.has(n)) localLinks++;
			if (localLinks > maxDegreeLocal) maxDegreeLocal = localLinks;
		}

		this.nodes = [];
		this.edges = [];

		for (const path of localNodesSet) {
			const isCenter = path === this.file.path;
			const color = this.plugin.settings.nodeColors[path] || GRAPH_CONSTANTS.COLORS.DEFAULT_NODE;
			const name = path.split('/').pop()?.replace('.md', '') || path;
			
			let localLinks = 0;
			const pathNeighbors = graphMap.get(path) || new Set();
			for(const n of pathNeighbors) if(localNodesSet.has(n)) localLinks++;
			
			const minR = s.nodeMinRadius;
			const maxR = s.nodeMaxRadius * 0.8;
			let radius = minR + ((localLinks / maxDegreeLocal) * (maxR - minR));
			if (isCenter) radius = s.nodeMaxRadius * 1.1; 

			this.nodes.push({
				id: path, name, color, radius,
				x: isCenter ? 0 : (Math.random() - 0.5) * 200,
				y: isCenter ? 0 : (Math.random() - 0.5) * 200,
				vx: 0, vy: 0, isCenter,
				visualRadius: radius, visualOpacity: 1.0,
				visualGlow: isCenter ? 15 : 0, visualTextOpacity: 1.0
			});
			nodeIndexMap.set(path, this.nodes.length - 1);
		}

		for (const path of localNodesSet) {
			const sourceIndex = nodeIndexMap.get(path);
			const pathNeighbors = graphMap.get(path) || new Set();
			for (const neighbor of pathNeighbors) {
				if (localNodesSet.has(neighbor)) {
					const targetIndex = nodeIndexMap.get(neighbor);
					if (targetIndex !== undefined && sourceIndex! < targetIndex) {
						this.edges.push({
							sourceIndex, targetIndex, hoverProgress: 0,
							visualOpacity: GRAPH_CONSTANTS.VISUALS.OPACITY_BASE_LINK,
							visualWidth: s.linkWidthBase
						});
					}
				}
			}
		}

		for(let i=0; i<150; i++) this.updatePhysics(true);
		this.wakeUp();
	}

	autoFitGraph() {
		if (this.nodes.length === 0 || !this.canvas.width) return;
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		
		for (const n of this.nodes) {
			const padding = n.radius + 60; 
			if (n.x - padding < minX) minX = n.x - padding;
			if (n.x + padding > maxX) maxX = n.x + padding;
			if (n.y - padding < minY) minY = n.y - padding;
			if (n.y + padding > maxY) maxY = n.y + padding;
		}

		const rect = this.container.getBoundingClientRect();
		if(rect.width === 0) return;

		const logicWidth = rect.width;
		const logicHeight = rect.height;

		const graphWidth = maxX - minX;
		const graphHeight = maxY - minY;

		const scaleX = logicWidth / (graphWidth || 1);
		const scaleY = logicHeight / (graphHeight || 1);
		const baseScale = Math.min(scaleX, scaleY) * 0.85; 

		let minScaleAllowed = 0.1;
		if (this.nodes.length > this.plugin.settings.localGraphZoomThreshold) {
			minScaleAllowed = 0.7; 
		}

		const finalScale = Math.max(minScaleAllowed, Math.min(baseScale, 1.8));

		let targetX = (minX + maxX) / 2;
		let targetY = (minY + maxY) / 2;

		if (finalScale === minScaleAllowed && this.nodes.length > this.plugin.settings.localGraphZoomThreshold) {
			const centerNode = this.nodes.find(n => n.isCenter);
			if (centerNode) {
				targetX = centerNode.x;
				targetY = centerNode.y;
			}
		}

		this.targetTransform.k = finalScale;
		this.targetTransform.x = (logicWidth / 2) - (targetX * finalScale);
		this.targetTransform.y = (logicHeight / 2) - (targetY * finalScale);
		
		if(this.isFirstRender) {
			this.transform = { ...this.targetTransform };
			this.isFirstRender = false;
		}
	}

	setupInteraction() {
		const getMousePos = (e: MouseEvent) => {
			const rect = this.canvas.getBoundingClientRect();
			return {
				x: (e.clientX - rect.left - this.targetTransform.x) / this.targetTransform.k,
				y: (e.clientY - rect.top - this.targetTransform.y) / this.targetTransform.k
			};
		};

		this.canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			const zoomSensitivity = 0.0012; 
			const delta = -e.deltaY * zoomSensitivity;
			const newScale = Math.max(0.1, Math.min(5, this.targetTransform.k * Math.exp(delta)));
			
			const rect = this.canvas.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			this.targetTransform.x = mouseX - (mouseX - this.targetTransform.x) * (newScale / this.targetTransform.k);
			this.targetTransform.y = mouseY - (mouseY - this.targetTransform.y) * (newScale / this.targetTransform.k);
			this.targetTransform.k = newScale;
			this.wakeUp();
			this.drawGraph();
		});

		this.canvas.addEventListener('mousedown', (e) => {
			if (e.button === 1) e.preventDefault();
			this.rawDragStartX = e.clientX;
			this.rawDragStartY = e.clientY;
			const pos = getMousePos(e);
			this.draggedNode = null;
			
			for (let i = this.nodes.length - 1; i >= 0; i--) {
				const node = this.nodes[i];
				const dx = pos.x - node.x; const dy = pos.y - node.y;
				if (dx * dx + dy * dy <= Math.pow(node.radius + 5, 2)) {
					this.draggedNode = node; break;
				}
			}

			if (this.draggedNode) {
				this.canvas.style.cursor = 'grabbing';
				this.wakeUp(); 
			} else {
				this.isDragging = true;
				this.canvas.style.cursor = 'move';
				this.dragStartX = e.clientX - this.transform.x;
				this.dragStartY = e.clientY - this.transform.y;
			}
			
			document.addEventListener('mousemove', this.boundMouseMove);
			document.addEventListener('mouseup', this.boundMouseUp);
		});

		this.canvas.addEventListener('mousemove', (e) => {
			if (this.isDragging || this.draggedNode) return; 

			const pos = getMousePos(e);
			let foundHover = null;
			for (let i = this.nodes.length - 1; i >= 0; i--) {
				const node = this.nodes[i];
				const dx = pos.x - node.x; const dy = pos.y - node.y;
				if (dx * dx + dy * dy <= Math.pow(node.radius + 3, 2)) {
					foundHover = node; break;
				}
			}
			
			if (foundHover !== this.hoveredNode) {
				this.hoveredNode = foundHover;
				this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
				this.wakeUp();
				this.drawGraph();
			}
		});

		this.canvas.addEventListener('mouseleave', () => {
			if (!this.isDragging && !this.draggedNode) {
				this.hoveredNode = null;
				this.canvas.style.cursor = 'grab';
				this.wakeUp();
			}
		});
	}

	handleGlobalMouseMove(e: MouseEvent) {
		if (this.draggedNode) {
			const rect = this.canvas.getBoundingClientRect();
			this.draggedNode.x = (e.clientX - rect.left - this.targetTransform.x) / this.targetTransform.k;
			this.draggedNode.y = (e.clientY - rect.top - this.targetTransform.y) / this.targetTransform.k;
			this.wakeUp(); 
		} else if (this.isDragging) {
			this.targetTransform.x = e.clientX - this.dragStartX;
			this.targetTransform.y = e.clientY - this.dragStartY;
			this.wakeUp();
			this.drawGraph();
		}
	}

	handleGlobalMouseUp(e: MouseEvent) {
		document.removeEventListener('mousemove', this.boundMouseMove);
		document.removeEventListener('mouseup', this.boundMouseUp);

		const dist = Math.abs(e.clientX - this.rawDragStartX) + Math.abs(e.clientY - this.rawDragStartY);
		if (dist < 5 && (this.draggedNode || this.hoveredNode)) {
			const targetNode = this.draggedNode || this.hoveredNode;
			if (!targetNode.isCenter || this.isStandalone) { 
				const fileToOpen = this.plugin.app.vault.getAbstractFileByPath(targetNode.id);
				if (fileToOpen instanceof TFile) {
					this.plugin.app.workspace.getLeaf(false).openFile(fileToOpen);
				}
			}
		}
		this.isDragging = false;
		this.draggedNode = null;
		this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
	}

	wakeUp() {
		if (this.isSleeping || this.energy < 1.0) {
			this.isSleeping = false;
			this.stableFrames = 0;
			this.energy = 1.0;
		}
	}

	startSimulation() {
		const tick = () => {
			if (!this.canvas.isConnected) {
				document.removeEventListener('mousemove', this.boundMouseMove);
				document.removeEventListener('mouseup', this.boundMouseUp);
				return; 
			}
			if (this.isFirstRender) this.autoFitGraph();

			if (!this.isSleeping) {
				this.updatePhysics();
				this.drawGraph();
			}
			this.animationFrameId = requestAnimationFrame(tick);
		};
		tick();
	}

	updatePhysics(isPrecalc: boolean = false) {
		const s = this.plugin.settings.localGraph;
		if (!isPrecalc) {
			this.transform.k += (this.targetTransform.k - this.transform.k) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
			this.transform.x += (this.targetTransform.x - this.transform.x) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
			this.transform.y += (this.targetTransform.y - this.transform.y) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
		}

		const repulsion = s.repulsionForce * 0.8;
		const springK = s.linkStrength * 0.8;
		const springLen = s.linkDistance;
		const currentFriction = isPrecalc ? 0.20 : 0.10 + (0.60 * this.energy);

		for (let i = 0; i < this.nodes.length; i++) {
			const n1 = this.nodes[i];
			for (let j = i + 1; j < this.nodes.length; j++) {
				const n2 = this.nodes[j];
				const dx = n1.x - n2.x; const dy = n1.y - n2.y;
				let distSq = dx * dx + dy * dy;
				if (distSq < 100) distSq = 100;
				const factor = repulsion / distSq;
				n1.vx += dx * factor; n1.vy += dy * factor;
				n2.vx -= dx * factor; n2.vy -= dy * factor;
			}
		}

		for (const edge of this.edges) {
			const n1 = this.nodes[edge.sourceIndex];
			const n2 = this.nodes[edge.targetIndex];
			const dx = n2.x - n1.x; const dy = n2.y - n1.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (dist === 0) continue;

			let force = (dist - springLen) * springK;
			const fx = (dx / dist) * force; const fy = (dy / dist) * force;
			n1.vx += fx; n1.vy += fy;
			n2.vx -= fx; n2.vy -= fy;
		}

		let totalVelocity = 0;
		for (const node of this.nodes) {
			if (node === this.draggedNode && !isPrecalc) continue;

			const dist = Math.sqrt(node.x * node.x + node.y * node.y);
			if (dist > 0) {
				const grav = (node.isCenter ? 0.1 : 0.02) * dist; 
				node.vx -= (node.x / dist) * grav;
				node.vy -= (node.y / dist) * grav;
			}

			node.vx *= currentFriction; 
			node.vy *= currentFriction;

			if (!isPrecalc) {
				if (Math.abs(node.vx) < 0.05) node.vx = 0;
				if (Math.abs(node.vy) < 0.05) node.vy = 0;
			}

			node.x += node.vx; node.y += node.vy;
			totalVelocity += Math.abs(node.vx) + Math.abs(node.vy);
		}

		if (!isPrecalc) {
			const averageVelocity = this.nodes.length > 0 ? totalVelocity / this.nodes.length : 0;
			if (averageVelocity < 0.05) {
				this.energy *= GRAPH_CONSTANTS.PHYSICS.ENERGY_DECAY;
				if (this.energy < 0.05) {
					this.stableFrames++;
					if (this.stableFrames > 15) {
						this.isSleeping = true; this.energy = 0;
						for (const node of this.nodes) { node.vx = 0; node.vy = 0; }
					}
				}
			} else {
				this.stableFrames = 0;
				if (this.draggedNode) this.energy = 1.0;
				else this.energy = Math.min(1.0, this.energy + 0.05);
			}
		}
	}

	drawGraph() {
		if (!this.ctx || !this.canvas) return;
		const s = this.plugin.settings.localGraph;

		this.ctx.imageSmoothingEnabled = true;
		this.ctx.imageSmoothingQuality = "high";

		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		const dpr = window.devicePixelRatio || 1;
		this.ctx.scale(dpr, dpr); 
		
		this.ctx.translate(this.transform.x, this.transform.y);
		this.ctx.scale(this.transform.k, this.transform.k);

		const leftLimit = -this.transform.x / this.transform.k;
		const rightLimit = (this.canvas.width / dpr - this.transform.x) / this.transform.k;
		const topLimit = -this.transform.y / this.transform.k;
		const bottomLimit = (this.canvas.height / dpr - this.transform.y) / this.transform.k;

		this.ctx.textAlign = "center";
		this.ctx.textBaseline = "middle"; 

		const visFactor = 0.3; 

		for (const edge of this.edges) {
			const n1 = this.nodes[edge.sourceIndex];
			const n2 = this.nodes[edge.targetIndex];

			const isHovered = this.hoveredNode === n1 || this.hoveredNode === n2;
			edge.hoverProgress = isHovered ? Math.min(1.0, edge.hoverProgress + 0.1) : Math.max(0.0, edge.hoverProgress - 0.1);

			this.ctx.beginPath(); this.ctx.moveTo(n1.x, n1.y); this.ctx.lineTo(n2.x, n2.y);
			this.ctx.strokeStyle = `rgba(150, 150, 150, ${s.enableColors ? 0.3 : 0.6})`;
			this.ctx.lineWidth = s.linkWidthBase / this.transform.k;
			this.ctx.stroke();

			if (edge.hoverProgress > 0) {
				this.ctx.save();
				this.ctx.globalAlpha = edge.hoverProgress;
				this.ctx.strokeStyle = "var(--color-purple)"; 
				this.ctx.lineWidth = s.linkWidthHover / this.transform.k;
				this.ctx.stroke(); this.ctx.restore();
			}
		}

		for (const node of this.nodes) {
			const isHovered = this.hoveredNode === node;
			const isConnectedToHover = this.hoveredNode ? (this.edges.some(e => (this.nodes[e.sourceIndex] === node && this.nodes[e.targetIndex] === this.hoveredNode) || (this.nodes[e.targetIndex] === node && this.nodes[e.sourceIndex] === this.hoveredNode))) || node === this.hoveredNode : true;
			
			let targetRadius = isHovered ? node.radius * 1.2 : node.radius;
			
			// Visual Dimming per il grafo locale
			let targetOpacity = GRAPH_CONSTANTS.VISUALS.OPACITY_UNFOCUSED_NODE;
			if (isConnectedToHover) targetOpacity = 1.0;
			else targetOpacity = 0.7; 

			node.visualRadius += (targetRadius - node.visualRadius) * visFactor;
			node.visualOpacity += (targetOpacity - node.visualOpacity) * visFactor;

			if (node.x < leftLimit - node.visualRadius * 3 || node.x > rightLimit + node.visualRadius * 3 || node.y < topLimit - node.visualRadius * 3 || node.y > bottomLimit + node.visualRadius * 3) {
				continue;
			}

			this.ctx.globalAlpha = node.visualOpacity;
			this.ctx.beginPath();
			this.ctx.arc(node.x, node.y, node.visualRadius, 0, 2 * Math.PI, false);

			const activeColor = s.enableColors ? node.color : GRAPH_CONSTANTS.COLORS.DEFAULT_NODE;
			
			if (node.isCenter) {
				this.ctx.fillStyle = activeColor;
				this.ctx.fill();
				
				if (s.enableGlow) {
					this.ctx.save();
					this.ctx.shadowBlur = 15;
					this.ctx.shadowColor = activeColor;
					this.ctx.strokeStyle = "rgba(255,255,255,0.5)";
					this.ctx.lineWidth = 2 / this.transform.k;
					this.ctx.stroke(); this.ctx.restore();
				}
			} else {
				this.ctx.fillStyle = activeColor;
				this.ctx.fill();
			}

			this.ctx.globalAlpha = node.visualOpacity;
			
			let fontColorHex = "#ffffff";
			let fontStyleSet = "normal";

			if (node.isCenter) {
				fontColorHex = s.centerNodeMatchColor ? activeColor : s.centerNodeFontColor;
				fontStyleSet = s.centerNodeFontStyle;
			} else {
				fontColorHex = s.standardNodeMatchColor ? activeColor : s.standardNodeFontColor;
				fontStyleSet = s.standardNodeFontStyle;
			}

			let fillStyle = this.resolveCSSColor(fontColorHex, "#ffffff");
			if (isHovered) fillStyle = "#ffffff"; 

			let baseFontSize = node.isCenter ? (s.fontSizeMax + 2) : Math.max(s.fontSizeMin, Math.min(s.fontSizeMax, node.radius)); 
			const fontStringRaw = this.getFontString(fontStyleSet, baseFontSize);
			const currentRadius = node.visualRadius; 

			if (isHovered) {
				const scaledUpSize = baseFontSize * GRAPH_CONSTANTS.VISUALS.TEXT_HOVER_SCALE;
				const minScreenSizeInCanvasUnits = GRAPH_CONSTANTS.VISUALS.MIN_HOVER_TEXT_SIZE_SCREEN / this.transform.k;
				baseFontSize = Math.max(scaledUpSize, minScreenSizeInCanvasUnits);
				const yPosHover = node.y + currentRadius + (GRAPH_CONSTANTS.VISUALS.TEXT_PADDING / this.transform.k);
				
				this.ctx.font = this.getFontString(fontStyleSet, baseFontSize);
				const textWidth = this.ctx.measureText(node.name).width;
				
				// Hover Badge protettivo per il testo
				const padX = 8 / this.transform.k;
				const padY = 4 / this.transform.k;
				this.ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
				this.ctx.beginPath();
				this.ctx.roundRect(node.x - textWidth/2 - padX, yPosHover - baseFontSize/2 - padY, textWidth + padX*2, baseFontSize + padY*2, 4 / this.transform.k);
				this.ctx.fill();

				this.ctx.fillStyle = fillStyle;
				this.ctx.fillText(node.name, node.x, yPosHover);
			} else {
				const yPos = node.y + currentRadius + 8; 
				const scaleLevel = Math.max(1, Math.min(Math.ceil(this.transform.k), 5));
				const textCanvas = this.getTextCanvas(node.name, fontStringRaw, baseFontSize, fillStyle, scaleLevel);
				
				const dprMultiplier = (window.devicePixelRatio || 1) * scaleLevel * 4.0; 
				const logicalWidth = textCanvas.width / dprMultiplier;
				const logicalHeight = textCanvas.height / dprMultiplier;
				
				this.ctx.drawImage(textCanvas, node.x - logicalWidth / 2, yPos - logicalHeight / 2, logicalWidth, logicalHeight);
			}
			
			this.ctx.globalAlpha = 1.0;
		}

		this.ctx.restore();
	}
}

// ---------------------------------------------------------
// 8. STANDALONE FLOATING LOCAL GRAPH
// ---------------------------------------------------------

class FloatingLocalGraphManager {
	plugin: SmartGraphPlugin;
	container: HTMLElement;
	renderer: SmartLocalGraphRenderer | null = null;
	isVisible: boolean = false;

	constructor(plugin: SmartGraphPlugin) {
		this.plugin = plugin;
		
		this.container = document.createElement('div');
		this.container.style.position = 'absolute';
		this.container.style.bottom = '20px';
		this.container.style.right = '20px';
		this.container.style.width = '400px';
		this.container.style.height = '350px';
		this.container.style.minWidth = '250px'; 
		this.container.style.minHeight = '200px';
		this.container.style.backgroundColor = 'var(--background-primary)';
		this.container.style.border = '1px solid var(--background-modifier-border)';
		this.container.style.borderRadius = 'var(--radius-m)';
		this.container.style.boxShadow = 'var(--shadow-l)';
		this.container.style.zIndex = '999'; 
		this.container.style.display = 'flex';
		this.container.style.flexDirection = 'column';
		this.container.style.overflow = 'hidden';
		this.container.style.resize = 'both'; 

		const header = document.createElement('div');
		header.style.height = '30px';
		header.style.backgroundColor = 'var(--background-secondary)';
		header.style.borderBottom = '1px solid var(--background-modifier-border)';
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.justifyContent = 'space-between';
		header.style.padding = '0 10px';
		header.style.cursor = 'grab';
		header.style.userSelect = 'none';

		const title = document.createElement('span');
		title.textContent = 'Local Graph';
		title.style.fontSize = 'var(--font-ui-small)';
		title.style.fontWeight = '600';
		title.style.color = 'var(--text-muted)';
		header.appendChild(title);

		const closeBtn = document.createElement('div');
		setIcon(closeBtn, 'x');
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.color = 'var(--text-muted)';
		closeBtn.addEventListener('click', () => this.destroy());
		header.appendChild(closeBtn);

		this.container.appendChild(header);

		const canvasContainer = document.createElement('div');
		canvasContainer.style.flexGrow = '1';
		canvasContainer.style.position = 'relative';
		this.container.appendChild(canvasContainer);

		this.plugin.app.workspace.containerEl.appendChild(this.container);
		this.isVisible = true;

		let isDragging = false;
		let offsetX = 0; let offsetY = 0;

		header.addEventListener('mousedown', (e) => {
			isDragging = true;
			header.style.cursor = 'grabbing';
			const rect = this.container.getBoundingClientRect();
			offsetX = e.clientX - rect.left;
			offsetY = e.clientY - rect.top;
		});

		document.addEventListener('mousemove', (e) => {
			if (!isDragging) return;
			const newLeft = e.clientX - offsetX;
			const newTop = e.clientY - offsetY;
			this.container.style.left = `${Math.max(0, Math.min(window.innerWidth - 100, newLeft))}px`;
			this.container.style.top = `${Math.max(0, Math.min(window.innerHeight - 100, newTop))}px`;
			this.container.style.right = 'auto'; 
			this.container.style.bottom = 'auto';
		});

		document.addEventListener('mouseup', () => {
			if (isDragging) {
				isDragging = false;
				header.style.cursor = 'grab';
			}
		});
	}

	updateGraph(file: TFile) {
		const canvasContainer = this.container.children[1] as HTMLElement;
		canvasContainer.empty();
		
		if (this.renderer) {
			cancelAnimationFrame(this.renderer.animationFrameId);
			this.renderer = null;
		}

		this.renderer = new SmartLocalGraphRenderer(canvasContainer, file, this.plugin, true);
	}

	destroy() {
		if (this.renderer) {
			cancelAnimationFrame(this.renderer.animationFrameId);
			document.removeEventListener('mousemove', this.renderer.boundMouseMove);
			document.removeEventListener('mouseup', this.renderer.boundMouseUp);
		}
		this.container.remove();
		this.isVisible = false;
		this.plugin.floatingLocalGraph = null;
		this.plugin.updateAllLocalGraphs(); 
	}
}

class SmartLocalGraphStandaloneView extends ItemView {
	constructor(leaf: WorkspaceLeaf, plugin: SmartGraphPlugin) { super(leaf); }
	getViewType(): string { return SMART_LOCAL_GRAPH_VIEW_TYPE; }
	getDisplayText(): string { return "Local Graph (Deprecated)"; }
	async onOpen() { this.containerEl.empty(); this.containerEl.createEl('p', {text: 'Please use the floating window via Command Palette.'}); }
}