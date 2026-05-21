import { App, Notice, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, TFile, setIcon, MarkdownView } from 'obsidian';

// ---------------------------------------------------------
// 1. DATA STRUCTURES & SETTINGS
// ---------------------------------------------------------

export const SMART_GRAPH_VIEW_TYPE = "smart-graph-view";

interface ClusterData {
	id: string; 
	name: string; 
	color: string; 
	isCustomColor?: boolean; 
}

interface GraphClusterSettings {
	clusters: ClusterData[];
	nodeColors: Record<string, string>; 
	nodePrimaryClusters: Record<string, string>; 
	absoluteCenters: string[]; 
	
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

	showLocalGraphInEditor: boolean;
	localGraphHeight: number;
}

// Impostazioni aggiornate in base alle specifiche fornite (graph_config.json)
const DEFAULT_SETTINGS: GraphClusterSettings = {
	clusters: [],
	nodeColors: {},
	nodePrimaryClusters: {},
	absoluteCenters: [],
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
	showLocalGraphInEditor: false, 
	localGraphHeight: 250
}

// ---------------------------------------------------------
// 2. MAIN PLUGIN CLASS
// ---------------------------------------------------------

export default class SmartGraphPlugin extends Plugin {
	settings!: GraphClusterSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			SMART_GRAPH_VIEW_TYPE,
			(leaf) => new SmartGraphView(leaf, this)
		);

		this.addSettingTab(new SmartGraphSettingTab(this.app, this));

		this.addRibbonIcon('graph-glyph', 'Open Smart Graph', () => {
			this.activateView();
		});

		this.addCommand({
			id: 'recalculate-cluster-colors',
			name: 'Recalculate Network and Colors',
			callback: () => this.runClusterAnalysis()
		});

		this.addCommand({
			id: 'open-smart-graph',
			name: 'Open Smart Graph',
			callback: () => this.activateView()
		});

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				this.updateAllLocalGraphs();
			})
		);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(refreshGraphs = true) {
		await this.saveData(this.settings);
		if (refreshGraphs) {
			const leaves = this.app.workspace.getLeavesOfType(SMART_GRAPH_VIEW_TYPE);
			if (leaves.length > 0) {
				const view = leaves[0].view as SmartGraphView;
				view.textCache.clear(); 
				view.wakeUp(); 
			}
			this.updateAllLocalGraphs();
		}
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(SMART_GRAPH_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf('tab');
			if(leaf) {
				await leaf.setViewState({ type: SMART_GRAPH_VIEW_TYPE, active: true });
			}
		}

		if(leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	// ---------------------------------------------------------
	// 3. GESTIONE GRAFI LOCALI NELL'EDITOR (BANNER INJECTION)
	// ---------------------------------------------------------
	updateAllLocalGraphs() {
		const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
		
		markdownLeaves.forEach(leaf => {
			const view = leaf.view as MarkdownView;
			const file = view.file;
			const contentEl = view.contentEl;

			let wrapper = contentEl.querySelector('.smart-local-graph-wrapper') as HTMLElement;

			if (!this.settings.showLocalGraphInEditor || !file) {
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

			new SmartLocalGraphRenderer(wrapper, file, this);
		});
	}

	// ---------------------------------------------------------
	// 4. LOGIC ENGINE (Community Detection & Absolute Centers)
	// ---------------------------------------------------------

	async runClusterAnalysis() {
		new Notice("Starting network analysis...");

		const graph = this.buildBidirectionalGraph();
		if (graph.size === 0) {
			new Notice("The graph is empty or has no links.");
			return;
		}

		let hubPaths = this.identifyHubsViaCommunities(graph);
		
		// Fallback di Sicurezza: se l'algoritmo non trova hub per frammentazione rete
		if (hubPaths.length === 0) {
			console.log("Community detection failed. Falling back to degree centrality.");
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
			const isEmpty = cleanContent.length === 0;

			if (isEmpty) {
				const neighbors = graph.get(file.path) || new Set();
				const connectedHubs = Array.from(neighbors).filter(n => hubPaths.includes(n));
				
				if (connectedHubs.length >= 2) {
					candidateCenters.push(file.path);
				}
			}
		}

		const finalCenters = candidateCenters.filter(path => {
			const neighbors = graph.get(path) || new Set();
			for (const neighbor of neighbors) {
				if (candidateCenters.includes(neighbor)) {
					return false; 
				}
			}
			return true;
		});

		this.settings.absoluteCenters = finalCenters;

		this.updateClusters(hubPaths, graph);
		this.calculateNodeColors(graph);
		await this.saveSettings(false); // Salva senza triggherare wakeUp base

		const leaves = this.app.workspace.getLeavesOfType(SMART_GRAPH_VIEW_TYPE);
		if (leaves.length > 0) {
			const view = leaves[0].view as SmartGraphView;
			view.hardReset(); // Forza ricaricamento totale nodi e ricalcolo colori
		}

		new Notice(`Analysis complete! Detected ${hubPaths.length} macro-groups and ${finalCenters.length} absolute centers.`);
	}

	buildBidirectionalGraph(): Map<string, Set<string>> {
		const graph = new Map<string, Set<string>>();
		const resolvedLinks = this.app.metadataCache.resolvedLinks;

		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			graph.set(file.path, new Set<string>());
		}

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

		for (const node of nodes) {
			labels.set(node, node);
		}

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
				if (degree > maxDegree) {
					maxDegree = degree;
					bestHub = member;
				}
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
			if (existing && existing.isCustomColor) {
				updatedClusters.push(existing);
			} else {
				autoHubs.push(path);
			}
		});

		if (autoHubs.length > 0) {
			const step = 360 / autoHubs.length;
			const baseHue = Math.random() * 360;
			const hues: number[] = [];

			for (let i = 0; i < autoHubs.length; i++) {
				hues.push((baseHue + (step * i)) % 360);
			}

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
				for (const neighbor of neighbors) {
					if (hubNeighbors.has(neighbor)) score += 0.2; 
				}

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
					if (weight > maxWeight) {
						maxWeight = weight;
						primaryHub = hubId;
					}

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
			r = hue2rgb(p, q, h + 1/3);
			g = hue2rgb(p, q, h);
			b = hue2rgb(p, q, h - 1/3);
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
			r: parseInt(result[1], 16),
			g: parseInt(result[2], 16),
			b: parseInt(result[3], 16)
		} : {r: 128, g: 128, b: 128};
	}
}

// ---------------------------------------------------------
// 5. SETTINGS PANEL 
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

		containerEl.createEl('h3', { text: 'Smart Graph Settings' });
		containerEl.createEl('p', { text: 'Use the floating menu inside the main graph for live tuning. Settings here apply globally.', cls: 'setting-item-description' });

		new Setting(containerEl)
			.setName('Enable Local Graph in Editor')
			.setDesc('Mostra automaticamente un mini-grafo interattivo in cima ad ogni nota, centrato su di essa.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showLocalGraphInEditor)
				.onChange(async (value) => {
					this.plugin.settings.showLocalGraphInEditor = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Local Graph Height')
			.setDesc('Altezza (in pixel) della fascia del mini-grafo all\'interno della nota.')
			.addSlider(slider => slider
				.setLimits(100, 500, 10)
				.setValue(this.plugin.settings.localGraphHeight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.localGraphHeight = value;
					await this.plugin.saveSettings();
				}));

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
// 6. CUSTOM VIEW & GRAPH CONSTANTS
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
		FONT_SIZE_CENTER: 15,
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
	
	nodes: { 
		id: string, 
		name: string, 
		color: string, 
		x: number, 
		y: number, 
		vx: number, 
		vy: number, 
		radius: number, 
		isAbsoluteCenter: boolean, 
		isHub: boolean,
		primaryCluster: string,
		primaryColor: string | undefined,
		degree: number,       
		spawnFrame: number,   
		isActive: boolean,    
		visualRadius: number,
		visualOpacity: number,
		visualGlow: number,
		visualTextOpacity: number,
		waveGlow1: number, 
		waveGlow2: number,
		targetX: number, 
		targetY: number  
	}[] = [];
	edges: { 
		sourceIndex: number, 
		targetIndex: number, 
		hoverProgress: number,
		visualOpacity: number,
		visualWidth: number
	}[] = [];

	transform = { x: 0, y: 0, k: 1 };
	targetTransform = { x: 0, y: 0, k: 1 };

	isDragging = false;
	dragStartX = 0;
	dragStartY = 0;
	
	rawDragStartX = 0;
	rawDragStartY = 0;

	draggedNode: any = null;
	hoveredNode: any = null; 
	
	resolvedHoverColor: string = '#a882ff';

	isSleeping: boolean = false;
	stableFrames: number = 0;
	energy: number = 1.0; 
	
	isFullySpawned: boolean = false; 

	textCache: Map<string, HTMLCanvasElement> = new Map();

	constructor(leaf: WorkspaceLeaf, plugin: SmartGraphPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SMART_GRAPH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Smart Graph";
	}

	getIcon(): string {
		return "graph-glyph"; 
	}

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
				this.targetTransform.x = this.transform.x;
				this.targetTransform.y = this.transform.y;
				this.targetTransform.k = this.transform.k;
			}
			this.drawGraph();
		});
		resizeObserver.observe(container);

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
			
			this.rawDragStartX = e.clientX;
			this.rawDragStartY = e.clientY;
			
			const pos = getMousePos(e);
			this.draggedNode = null;
			
			for (let i = this.nodes.length - 1; i >= 0; i--) {
				const node = this.nodes[i];
				if (this.plugin.settings.spawnAnimation === 'hierarchical' && !node.isActive) continue; 
				
				const dx = pos.x - node.x;
				const dy = pos.y - node.y;
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
		});

		this.canvas.addEventListener('mousemove', (e) => {
			if (this.draggedNode) {
				const pos = getMousePos(e);
				this.draggedNode.x = pos.x;
				this.draggedNode.y = pos.y;
				this.draggedNode.vx = 0;
				this.draggedNode.vy = 0;
				this.wakeUp(); 
			} else if (this.isDragging) {
				this.transform.x = e.clientX - this.dragStartX;
				this.transform.y = e.clientY - this.dragStartY;
				this.targetTransform.x = this.transform.x;
				this.targetTransform.y = this.transform.y;
				this.wakeUp();
				this.drawGraph();
			} else {
				const pos = getMousePos(e);
				let foundHover = null;
				for (let i = this.nodes.length - 1; i >= 0; i--) {
					const node = this.nodes[i];
					if (!node.isActive) continue; 
					
					const dx = pos.x - node.x;
					const dy = pos.y - node.y;
					if (dx * dx + dy * dy <= Math.pow(node.radius + 3, 2)) {
						foundHover = node;
						break;
					}
				}
				
				if (foundHover !== this.hoveredNode) {
					this.hoveredNode = foundHover;
					this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
					this.wakeUp();
					this.drawGraph();
				}
			}
		});

		const stopInteraction = () => {
			this.isDragging = false;
			this.draggedNode = null;
			this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
		};

		this.canvas.addEventListener('mouseup', (e) => {
			const dist = Math.abs(e.clientX - this.rawDragStartX) + Math.abs(e.clientY - this.rawDragStartY);
			
			if (dist < 5) {
				const targetNode = this.draggedNode || this.hoveredNode;
				
				if (targetNode) {
					const file = this.plugin.app.vault.getAbstractFileByPath(targetNode.id);
					if (file instanceof TFile) {
						if (e.button === 0) {
							this.plugin.app.workspace.getLeaf(false).openFile(file);
						} else if (e.button === 1) {
							this.plugin.app.workspace.getLeaf(true).openFile(file);
						}
					}
				}
			}
			stopInteraction();
		});

		this.canvas.addEventListener('mouseleave', () => {
			stopInteraction();
			this.hoveredNode = null;
		});

		this.initPhysicsData();
		this.startSimulation();
	}

	async onClose() {
		cancelAnimationFrame(this.animationFrameId);
	}

	wakeUp() {
		if (this.isSleeping || this.energy < 1.0) {
			this.isSleeping = false;
			this.stableFrames = 0;
			this.energy = 1.0;
		}
	}

	// Metodo per forzare la ricarica pulita e il riavvio completo dell'animazione
	hardReset() {
		this.currentFrame = 0;
		this.isFullySpawned = false;
		this.energy = 1.0;
		this.isSleeping = false;
		this.stableFrames = 0;
		if(this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.initPhysicsData();
	}

	reloadFullGraph() {
		this.hardReset();
	}

	updateNodeRadii() {
		for (const node of this.nodes) {
			let calculatedRadius = this.plugin.settings.nodeMinRadius + (Math.sqrt(node.degree) * 3.5);
			if (node.isHub) calculatedRadius = Math.max(calculatedRadius, this.plugin.settings.nodeMaxRadius * 0.7);
			
			let radius = Math.min(calculatedRadius, this.plugin.settings.nodeMaxRadius);
			if (node.isAbsoluteCenter) radius = this.plugin.settings.nodeMaxRadius * 1.2; 
			
			node.radius = radius;
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
		this.resolvedHoverColor = this.resolveCSSColor(this.plugin.settings.hoverLinkColor, '#a882ff');
	}

	getTextCanvas(text: string, fontStyle: string, fontSize: number, color: string, scaleLevel: number): HTMLCanvasElement {
		const key = `${text}_${fontStyle}_${fontSize}_${color}_${scaleLevel}`;
		let cached = this.textCache.get(key);
		if (cached) return cached;

		const offscreenCanvas = document.createElement('canvas');
		const offscreenCtx = offscreenCanvas.getContext('2d')!;
		
		const baseDpr = window.devicePixelRatio || 1;
		const dpr = baseDpr * scaleLevel; 
		
		const fontStr = `${fontStyle} ${fontSize}px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
		offscreenCtx.font = fontStr;
		
		const textWidth = Math.ceil(offscreenCtx.measureText(text).width);
		const logicalWidth = textWidth + GRAPH_CONSTANTS.VISUALS.TEXT_PADDING * 1.5;
		const logicalHeight = fontSize + GRAPH_CONSTANTS.VISUALS.TEXT_PADDING * 1.5;
		
		offscreenCanvas.width = logicalWidth * dpr;
		offscreenCanvas.height = logicalHeight * dpr;
		
		offscreenCtx.scale(dpr, dpr);
		
		offscreenCtx.font = fontStr;
		offscreenCtx.fillStyle = color;
		offscreenCtx.textAlign = 'center';
		offscreenCtx.textBaseline = 'middle';
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
		toggleBtn.style.backgroundColor = 'transparent';
		toggleBtn.style.border = 'none';
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
		uiPanel.style.overflow = 'hidden';
		uiPanel.style.maxHeight = '80vh';

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
		
		const title = header.createEl('div', { text: 'Graph Options' });
		title.style.fontWeight = '600';
		title.style.color = 'var(--text-normal)';
		title.style.fontSize = '14px';
		title.style.userSelect = 'none';

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

		const resetBtn = headerIcons.createEl('div');
		resetBtn.style.cursor = 'pointer';
		resetBtn.style.color = 'var(--text-muted)';
		resetBtn.style.display = 'flex';
		setIcon(resetBtn, 'rotate-ccw'); 
		resetBtn.title = 'Reset to Default';
		
		resetBtn.addEventListener('mouseenter', () => { resetBtn.style.color = 'var(--text-normal)'; });
		resetBtn.addEventListener('mouseleave', () => { resetBtn.style.color = 'var(--text-muted)'; });

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
			sectionHeader.style.letterSpacing = '0.05em';
			
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
			select.style.backgroundColor = 'var(--background-modifier-form-field)';
			select.style.border = '1px solid var(--background-modifier-border)';
			select.style.color = 'var(--text-normal)';
			select.style.borderRadius = 'var(--radius-s)';
			
			for (const key of Object.keys(options)) {
				const text = options[key];
				const option = select.createEl('option', { text, value: key });
				if (key === value) option.selected = true;
			}

			select.addEventListener('change', async (e) => {
				onChange((e.target as HTMLSelectElement).value);
			});
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
			label.style.color = 'var(--text-normal)';
			
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
			label.style.color = 'var(--text-normal)';

			const toggleContainer = wrapper.createEl('div');
			toggleContainer.addClass('checkbox-container'); 
			if(value) toggleContainer.addClass('is-enabled');

			toggleContainer.addEventListener('click', async () => {
				const isEnabled = toggleContainer.hasClass('is-enabled');
				if(isEnabled) {
					toggleContainer.removeClass('is-enabled');
				} else {
					toggleContainer.addClass('is-enabled');
				}
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

			const displaySection = createSection('Display', true);
			
			createSelect(displaySection, 'Spawn Animation', { radial: 'Radial Burst', hierarchical: 'Hierarchical Wave' }, this.plugin.settings.spawnAnimation, async (val) => {
				this.plugin.settings.spawnAnimation = val as 'hierarchical' | 'radial';
				await this.plugin.saveSettings(false); // Salva senza refresh standard
				this.hardReset(); // Usa il nostro Hard Reset per resettare completamente fisica e visiva
			});

			createSlider(displaySection, 'Label Visibility Threshold', 0, 3, 0.1, this.plugin.settings.labelVisibilityThreshold, async (val) => {
				this.plugin.settings.labelVisibilityThreshold = val;
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			createToggle(displaySection, 'Force all labels visible', this.plugin.settings.showAllLabels, async (val) => {
				this.plugin.settings.showAllLabels = val;
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			createToggle(displaySection, 'High contrast labels (White)', this.plugin.settings.whiteLabels, async (val) => {
				this.plugin.settings.whiteLabels = val;
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			createTextInput(displaySection, 'Hover Link Color', 'e.g., var(--color-purple)', this.plugin.settings.hoverLinkColor, async (val) => {
				this.plugin.settings.hoverLinkColor = val || "var(--color-purple)";
				await this.plugin.saveSettings(false);
				this.updateResolvedColor(); 
				this.drawGraph();
			});

			// SEZIONE LOCAL GRAPH
			const localGraphSection = createSection('Editor Local Graph', false);
			createToggle(localGraphSection, 'Enable Local Graph', this.plugin.settings.showLocalGraphInEditor, async (val) => {
				this.plugin.settings.showLocalGraphInEditor = val;
				await this.plugin.saveSettings(false); 
				this.plugin.updateAllLocalGraphs();
			});
			createSlider(localGraphSection, 'Graph Height (px)', 100, 500, 10, this.plugin.settings.localGraphHeight, async (val) => {
				this.plugin.settings.localGraphHeight = val;
				await this.plugin.saveSettings(false);
				this.plugin.updateAllLocalGraphs();
			});

			const appearanceSection = createSection('Appearance', false);

			createToggle(appearanceSection, 'Enable Node Colors', this.plugin.settings.enableColors, async (val) => {
				this.plugin.settings.enableColors = val;
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			createToggle(appearanceSection, 'Enable Glow Effects', this.plugin.settings.enableGlow, async (val) => {
				this.plugin.settings.enableGlow = val;
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			createSlider(appearanceSection, 'Glow Intensity', 0.1, 3.0, 0.1, this.plugin.settings.glowIntensity, async (val) => {
				this.plugin.settings.glowIntensity = val;
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			createSlider(appearanceSection, 'Node Min Size', 1, 10, 1, this.plugin.settings.nodeMinRadius, async (val) => {
				this.plugin.settings.nodeMinRadius = val;
				this.updateNodeRadii();
				await this.plugin.saveSettings(false);
			});

			createSlider(appearanceSection, 'Node Max Size', 10, 50, 1, this.plugin.settings.nodeMaxRadius, async (val) => {
				this.plugin.settings.nodeMaxRadius = val;
				this.updateNodeRadii();
				await this.plugin.saveSettings(false);
			});

			createSlider(appearanceSection, 'Font Size Base', 6, 24, 1, this.plugin.settings.fontSizeMin, async (val) => {
				this.plugin.settings.fontSizeMin = val;
				this.textCache.clear();
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			createSlider(appearanceSection, 'Font Size Max', 10, 36, 1, this.plugin.settings.fontSizeMax, async (val) => {
				this.plugin.settings.fontSizeMax = val;
				this.textCache.clear();
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			createSlider(appearanceSection, 'Link Base Thickness', 0.1, 3.0, 0.1, this.plugin.settings.linkWidthBase, async (val) => {
				this.plugin.settings.linkWidthBase = val;
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			createSlider(appearanceSection, 'Link Hover Thickness', 0.5, 5.0, 0.1, this.plugin.settings.linkWidthHover, async (val) => {
				this.plugin.settings.linkWidthHover = val;
				await this.plugin.saveSettings(false);
				this.drawGraph();
			});

			const groupSection = createSection('Groups', false);
			
			if(this.plugin.settings.clusters.length === 0) {
				const emptyMsg = groupSection.createEl('div', { text: 'No groups detected.' });
				emptyMsg.style.fontSize = 'var(--font-ui-small)';
				emptyMsg.style.color = 'var(--text-muted)';
				emptyMsg.style.textAlign = 'center';
			}

			for (const cluster of this.plugin.settings.clusters) {
				const row = groupSection.createEl('div');
				row.style.display = 'flex';
				row.style.alignItems = 'center';
				row.style.justifyContent = 'space-between';

				const name = row.createEl('div', { text: cluster.name });
				name.style.fontSize = 'var(--font-ui-small)';
				name.style.color = 'var(--text-normal)';
				name.style.overflow = 'hidden';
				name.style.textOverflow = 'ellipsis';
				name.style.whiteSpace = 'nowrap';
				name.style.maxWidth = '200px';

				const colorPicker = row.createEl('input');
				colorPicker.type = 'color';
				colorPicker.value = cluster.color;
				colorPicker.style.border = 'none';
				colorPicker.style.padding = '0';
				colorPicker.style.width = '20px';
				colorPicker.style.height = '20px';
				colorPicker.style.borderRadius = '50%';
				colorPicker.style.cursor = 'pointer';
				colorPicker.style.backgroundColor = 'transparent';

				colorPicker.addEventListener('change', async (e) => {
					cluster.color = (e.target as HTMLInputElement).value;
					cluster.isCustomColor = true; 
					
					const tempGraph = this.plugin.buildBidirectionalGraph();
					this.plugin.calculateNodeColors(tempGraph);
					
					for(const n of this.nodes) {
						n.color = this.plugin.settings.nodeColors[n.id] || "#888888";
					}
					
					await this.plugin.saveSettings(false);
					this.drawGraph();
				});
			}

			const recalcBtn = groupSection.createEl('button', { text: 'Recalculate Network' });
			recalcBtn.addClass('mod-cta'); 
			recalcBtn.style.marginTop = '8px';
			recalcBtn.style.width = '100%';
			
			recalcBtn.addEventListener('click', async () => {
				await this.plugin.runClusterAnalysis();
				renderControls(); 
			});

			const forceSection = createSection('Forces', false);

			createSlider(forceSection, 'Repel Force', 0, 15000, 100, this.plugin.settings.repulsionForce, async (val) => {
				this.plugin.settings.repulsionForce = val;
				await this.plugin.saveSettings(false);
				this.wakeUp();
			});

			createSlider(forceSection, 'Hub to Center Distance', 10, 2000, 10, this.plugin.settings.absoluteCenterDistance, async (val) => {
				this.plugin.settings.absoluteCenterDistance = val;
				await this.plugin.saveSettings(false);
				this.wakeUp();
			});

			createSlider(forceSection, 'Link Distance', 10, 500, 5, this.plugin.settings.linkDistance, async (val) => {
				this.plugin.settings.linkDistance = val;
				await this.plugin.saveSettings(false);
				this.wakeUp();
			});

			createSlider(forceSection, 'Link Force', 0.001, 0.2, 0.001, this.plugin.settings.linkStrength, async (val) => {
				this.plugin.settings.linkStrength = val;
				await this.plugin.saveSettings(false);
				this.wakeUp();
			});
			
			createSlider(forceSection, 'Center Gravity', 0.001, 0.1, 0.001, this.plugin.settings.centerGravity, async (val) => {
				this.plugin.settings.centerGravity = val;
				await this.plugin.saveSettings(false);
				this.wakeUp();
			});
		};

		renderControls();

		resetBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			
			// Reimposta le impostazioni coerentemente con graph_config.json
			this.plugin.settings.spawnAnimation = 'radial';
			this.plugin.settings.repulsionForce = 200;
			this.plugin.settings.linkDistance = 115;
			this.plugin.settings.linkStrength = 0.038;
			this.plugin.settings.centerGravity = 0.1;
			this.plugin.settings.showAllLabels = false;
			this.plugin.settings.whiteLabels = false;
			this.plugin.settings.hoverLinkColor = "var(--color-purple)";
			this.plugin.settings.labelVisibilityThreshold = 0;
			this.plugin.settings.absoluteCenterDistance = 10;
			this.plugin.settings.enableColors = true;
			this.plugin.settings.enableGlow = true;
			this.plugin.settings.glowIntensity = 1.0;
			this.plugin.settings.nodeMinRadius = 6;
			this.plugin.settings.nodeMaxRadius = 35;
			this.plugin.settings.fontSizeMin = 12;
			this.plugin.settings.fontSizeMax = 18;
			this.plugin.settings.linkWidthBase = 1.0;
			this.plugin.settings.linkWidthHover = 2.0;

			await this.plugin.saveSettings(false);
			this.updateResolvedColor();
			this.updateNodeRadii();
			
			renderControls();
			this.hardReset();
		});

		uiPanel.addEventListener('mousedown', (e) => e.stopPropagation());
		uiPanel.addEventListener('wheel', (e) => e.stopPropagation());
	}

	stepPhysics(isPrecalc: boolean = false): number {
		const repulsionConstant = this.plugin.settings.repulsionForce; 
		const baseSpringConstant = this.plugin.settings.linkStrength;
		const baseSpringLength = this.plugin.settings.linkDistance;
		const absCenterDistance = this.plugin.settings.absoluteCenterDistance;
		const gravity = this.plugin.settings.centerGravity;

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
				const fx = dx * factor;
				const fy = dy * factor;

				n1.vx += fx; n1.vy += fy;
				n2.vx -= fx; n2.vy -= fy;
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
				initialPositions.set(path, {
					x: (Math.random() - 0.5) * 10,
					y: (Math.random() - 0.5) * 10
				});
			} else if (isHub) {
				const angle = Math.random() * Math.PI * 2;
				const absDist = this.plugin.settings.absoluteCenterDistance;
				const dist = absDist + (Math.random() * 50 - 25);
				initialPositions.set(path, {
					x: Math.cos(angle) * dist,
					y: Math.sin(angle) * dist
				});
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
			
			let calculatedRadius = this.plugin.settings.nodeMinRadius + (Math.sqrt(degree) * 3.5);
			if (isHub) calculatedRadius = Math.max(calculatedRadius, this.plugin.settings.nodeMaxRadius * 0.7);
			
			let radius = Math.min(calculatedRadius, this.plugin.settings.nodeMaxRadius);
			if (isAbsoluteCenter) radius = this.plugin.settings.nodeMaxRadius * 1.2; 

			let startX = 0;
			let startY = 0;

			if (isAbsoluteCenter || isHub) {
				const pos = initialPositions.get(path);
				startX = pos!.x;
				startY = pos!.y;
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

			const isActiveByDefault = this.plugin.settings.spawnAnimation === 'radial';

			tempNodes.push({
				id: path, 
				name, 
				color, 
				radius,
				x: startX, 
				y: startY,
				vx: 0, 
				vy: 0,
				isAbsoluteCenter,
				isHub,
				primaryCluster: primaryClusterId,
				primaryColor: primaryColor,
				degree: degree,       
				spawnFrame: 0,   
				isActive: isActiveByDefault, 
				visualRadius: 0,
				visualOpacity: 0,
				visualGlow: 0,
				visualTextOpacity: 0,
				waveGlow1: 0,
				waveGlow2: 0,
				targetX: startX, 
				targetY: startY
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
					this.edges.push({ 
						sourceIndex, 
						targetIndex, 
						hoverProgress: 0,
						visualOpacity: 0,
						visualWidth: 0
					});
				}
			}
		}

		const isRadial = this.plugin.settings.spawnAnimation === 'radial';

		if (isRadial) {
			for (const node of this.nodes) node.isActive = true; 
			for (let i = 0; i < 200; i++) {
				this.stepPhysics(true); 
			}

			for (const node of this.nodes) {
				node.targetX = node.x;
				node.targetY = node.y;
				
				const scatterAngle = Math.random() * Math.PI * 2;
				const scatterDist = Math.random() * 150 + 50; 
				node.x = node.targetX + Math.cos(scatterAngle) * scatterDist;
				node.y = node.targetY + Math.sin(scatterAngle) * scatterDist;
				
				node.isActive = false; 
			}
		} else {
			for (const node of this.nodes) {
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

		let activeNodesCount = 0;
		for (const node of this.nodes) {
			if (this.plugin.settings.spawnAnimation === 'radial') {
				node.isActive = true; 
			} else if (!node.isActive && this.currentFrame >= node.spawnFrame) {
				node.isActive = true; 
			}
			if (node.isActive) activeNodesCount++;
		}

		this.isFullySpawned = activeNodesCount === this.nodes.length;

		if (this.isSleeping) {
			this.transform.k += (this.targetTransform.k - this.transform.k) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
			this.transform.x += (this.targetTransform.x - this.transform.x) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
			this.transform.y += (this.targetTransform.y - this.transform.y) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
			return;
		}

		this.transform.k += (this.targetTransform.k - this.transform.k) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
		this.transform.x += (this.targetTransform.x - this.transform.x) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
		this.transform.y += (this.targetTransform.y - this.transform.y) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;

		let totalVelocity = 0;

		if (!this.isFullySpawned && this.plugin.settings.spawnAnimation === 'radial') {
			for (const node of this.nodes) {
				if (!node.isActive || node === this.draggedNode) continue;
				
				const diffX = node.targetX - node.x;
				const diffY = node.targetY - node.y;
				node.x += diffX * 0.15;
				node.y += diffY * 0.15;
				totalVelocity += Math.abs(diffX) + Math.abs(diffY);
			}
		} 
		else {
			totalVelocity = this.stepPhysics(false); 
		}

		const averageVelocity = activeNodesCount > 0 ? totalVelocity / activeNodesCount : 0;

		if (this.isFullySpawned && averageVelocity < GRAPH_CONSTANTS.PHYSICS.SLEEP_VELOCITY_THRESHOLD) { 
			this.energy *= GRAPH_CONSTANTS.PHYSICS.ENERGY_DECAY;
			
			if (this.energy < 0.05) {
				this.stableFrames++;
				if (this.stableFrames > GRAPH_CONSTANTS.PHYSICS.SLEEP_FRAME_THRESHOLD) { 
					this.isSleeping = true;
					this.energy = 0;
					for (const node of this.nodes) {
						node.vx = 0;
						node.vy = 0;
					}
				}
			}
		} else {
			this.stableFrames = 0;
			if (this.draggedNode) {
				this.energy = 1.0;
			} else {
				this.energy = Math.min(1.0, this.energy + 0.05);
			}
		}
	}

	drawGraph() {
		if (!this.ctx || !this.canvas) return;

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
				const n1 = this.nodes[edge.sourceIndex];
				const n2 = this.nodes[edge.targetIndex];
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
		const wave2Radius = Math.max(0, waveRadius - GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE2_OFFSET);

		for (const node of this.nodes) {
			let isVisuallyActive = true;
			let w1Glow = 0;
			let w2Glow = 0;

			if (this.plugin.settings.spawnAnimation === 'hierarchical') {
				isVisuallyActive = node.isActive;
			} else {
				const distFromCenter = Math.sqrt(node.x * node.x + node.y * node.y);
				isVisuallyActive = distFromCenter <= waveRadius;

				if (isVisuallyActive && this.plugin.settings.enableGlow) {
					const distBehindFront1 = waveRadius - distFromCenter;
					if (distBehindFront1 >= 0 && distBehindFront1 < GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE1_THICKNESS) {
						const prog1 = 1 - (distBehindFront1 / GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE1_THICKNESS);
						w1Glow = Math.sin(prog1 * Math.PI); 
					}
					
					const distBehindFront2 = wave2Radius - distFromCenter;
					if (distBehindFront2 >= 0 && distBehindFront2 < GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE2_THICKNESS) {
						const prog2 = 1 - (distBehindFront2 / GRAPH_CONSTANTS.VISUALS.RADIAL_WAVE2_THICKNESS);
						w2Glow = Math.sin(prog2 * Math.PI); 
					}
				}
			}

			if (!isVisuallyActive) {
				node.visualRadius = 0;
				node.visualOpacity = 0;
				node.visualGlow = 0;
				node.visualTextOpacity = 0;
				node.waveGlow1 = 0;
				node.waveGlow2 = 0;
				continue; 
			}

			node.waveGlow1 = w1Glow * this.plugin.settings.glowIntensity;
			node.waveGlow2 = w2Glow * this.plugin.settings.glowIntensity;

			const isHovered = this.hoveredNode === node;
			const isConnectedToHover = this.hoveredNode ? connectedNodes.has(node) : true;
			const isGroupHighlight = groupHighlightedNodes.has(node);

			let targetRadius = node.radius;
			if (isHovered) targetRadius = node.radius * GRAPH_CONSTANTS.VISUALS.NODE_HOVER_SCALE;
			else if (isGroupHighlight) targetRadius = node.radius * GRAPH_CONSTANTS.VISUALS.NODE_GROUP_HIGHLIGHT_SCALE;

			let targetOpacity = (isConnectedToHover || isGroupHighlight) ? 1.0 : GRAPH_CONSTANTS.VISUALS.OPACITY_UNFOCUSED_NODE;
			
			if (this.plugin.settings.spawnAnimation === 'radial' && (w1Glow > 0.05 || w2Glow > 0.05)) {
				targetOpacity = 1.0; 
			}

			let targetGlow = 0;
			if (this.plugin.settings.enableGlow) {
				if (node.isAbsoluteCenter) targetGlow = GRAPH_CONSTANTS.VISUALS.CENTER_GLOW_BLUR * this.plugin.settings.glowIntensity;
				else if (isGroupHighlight && node.primaryColor) targetGlow = GRAPH_CONSTANTS.VISUALS.GROUP_HIGHLIGHT_GLOW_BLUR * this.plugin.settings.glowIntensity;
			}

			let targetTextOpacity = 1.0;
			const threshold = this.plugin.settings.labelVisibilityThreshold;
			if (!this.plugin.settings.showAllLabels && !isHovered && !isGroupHighlight && threshold > 0) {
				const fadeStart = threshold;
				const fadeEnd = threshold * 0.4;
				targetTextOpacity = Math.max(0, Math.min(1, (this.transform.k - fadeEnd) / (fadeStart - fadeEnd)));
			}
			targetTextOpacity *= targetOpacity;

			node.visualRadius = lerp(node.visualRadius, targetRadius, visFactor);
			node.visualOpacity = lerp(node.visualOpacity, targetOpacity, visFactor);
			node.visualGlow = lerp(node.visualGlow, targetGlow, visFactor);
			node.visualTextOpacity = lerp(node.visualTextOpacity, targetTextOpacity, visFactor);
		}

		for (const edge of this.edges) {
			const n1 = this.nodes[edge.sourceIndex];
			const n2 = this.nodes[edge.targetIndex];

			let isLinkVisuallyActive = true;
			if (this.plugin.settings.spawnAnimation === 'hierarchical') {
				isLinkVisuallyActive = n1.isActive && n2.isActive;
			} else {
				const dist1Sq = n1.x * n1.x + n1.y * n1.y;
				const dist2Sq = n2.x * n2.x + n2.y * n2.y;
				const waveSq = waveRadius * waveRadius;
				isLinkVisuallyActive = (dist1Sq <= waveSq) && (dist2Sq <= waveSq);
			}

			if (!isLinkVisuallyActive) {
				edge.visualOpacity = 0;
				edge.visualWidth = 0;
				continue;
			}
			
			const isHovered = this.hoveredNode === n1 || this.hoveredNode === n2;
			const isGroupLink = this.hoveredNode && 
								n1.primaryCluster === this.hoveredNode.primaryCluster && 
								n2.primaryCluster === this.hoveredNode.primaryCluster &&
								this.hoveredNode.primaryCluster !== "";

			if (isHovered) {
				edge.hoverProgress = Math.min(1.0, edge.hoverProgress + GRAPH_CONSTANTS.VISUALS.HOVER_FADE_IN_SPEED); 
			} else {
				edge.hoverProgress = Math.max(0.0, edge.hoverProgress - GRAPH_CONSTANTS.VISUALS.HOVER_FADE_OUT_SPEED); 
			}

			let targetOpacity = GRAPH_CONSTANTS.VISUALS.OPACITY_BASE_LINK;
			let targetWidth = this.plugin.settings.linkWidthBase;

			if (isGroupLink) {
				targetOpacity = GRAPH_CONSTANTS.VISUALS.OPACITY_GROUP_HIGHLIGHT_LINK;
				targetWidth = this.plugin.settings.linkWidthBase * 1.5;
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
				const groupColor = this.plugin.settings.enableColors 
					? (n1.primaryColor || "rgba(150, 150, 150, 0.4)") 
					: "rgba(150, 150, 150, 0.6)";
				this.ctx.strokeStyle = groupColor;
			} else {
				this.ctx.strokeStyle = `rgba(150, 150, 150, 1.0)`; 
			}
			
			this.ctx.globalAlpha = edge.visualOpacity;
			this.ctx.lineWidth = edge.visualWidth / this.transform.k;
			this.ctx.stroke();

			if (edge.hoverProgress > 0) {
				this.ctx.save();
				this.ctx.beginPath();
				this.ctx.moveTo(n1.x, n1.y);
				this.ctx.lineTo(n2.x, n2.y);
				this.ctx.globalAlpha = edge.hoverProgress * edge.visualOpacity; 
				this.ctx.strokeStyle = this.resolvedHoverColor;
				this.ctx.lineWidth = this.plugin.settings.linkWidthHover / this.transform.k;
				this.ctx.stroke();
				this.ctx.restore();
			}
		}

		this.ctx.globalAlpha = 1.0; 

		const renderNode = (node: any, isHovered: boolean, isGroupHighlight: boolean) => {
			const currentRadius = node.visualRadius + (node.radius * (node.waveGlow1 || 0) * 0.25);

			if (currentRadius < 0.1) return;

			if (node.x < leftLimit - currentRadius * 3 || node.x > rightLimit + currentRadius * 3 ||
				node.y < topLimit - currentRadius * 3 || node.y > bottomLimit + currentRadius * 3) {
				return;
			}

			const activeNodeColor = this.plugin.settings.enableColors ? node.color : GRAPH_CONSTANTS.COLORS.DEFAULT_NODE;
			const activePrimaryColor = this.plugin.settings.enableColors ? node.primaryColor : undefined;

			this.ctx.globalAlpha = node.visualOpacity;
			this.ctx.beginPath();
			this.ctx.arc(node.x, node.y, currentRadius, 0, 2 * Math.PI, false);

			if (node.isAbsoluteCenter) {
				this.ctx.fillStyle = this.plugin.settings.enableColors ? GRAPH_CONSTANTS.COLORS.CENTER_NODE : GRAPH_CONSTANTS.COLORS.DEFAULT_NODE; 
				this.ctx.fill();

				if (this.plugin.settings.enableGlow) {
					this.ctx.save();
					this.ctx.strokeStyle = this.plugin.settings.enableColors ? GRAPH_CONSTANTS.COLORS.CENTER_BORDER : 'rgba(150, 150, 150, 0.6)'; 
					this.ctx.lineWidth = 3 / this.transform.k;
					this.ctx.shadowBlur = node.visualGlow; 
					this.ctx.shadowColor = this.plugin.settings.enableColors ? GRAPH_CONSTANTS.COLORS.CENTER_GLOW : 'rgba(150, 150, 150, 0.8)';
					this.ctx.stroke();
					this.ctx.restore();
				}
			} else {
				const isWaveActive = this.plugin.settings.spawnAnimation === 'radial' && (node.waveGlow1 > 0 || node.waveGlow2 > 0);
				
				this.ctx.fillStyle = isWaveActive ? 'transparent' : activeNodeColor;
				
				if (isWaveActive) {
					this.ctx.save();
					
					if (node.waveGlow1 > 0.01) {
						this.ctx.shadowBlur = GRAPH_CONSTANTS.VISUALS.RADIAL_GLOW_MAX_INTENSITY * node.waveGlow1;
						this.ctx.shadowColor = activePrimaryColor || activeNodeColor;
						this.ctx.fillStyle = activePrimaryColor || activeNodeColor;
						this.ctx.globalAlpha = node.visualOpacity * node.waveGlow1 * 0.9;
						this.ctx.fill();
					}

					if (node.waveGlow2 > 0.01) {
						this.ctx.shadowBlur = 20 * node.waveGlow2;
						this.ctx.shadowColor = '#ffffff'; 
						this.ctx.fillStyle = activePrimaryColor || activeNodeColor;
						this.ctx.globalAlpha = node.visualOpacity * node.waveGlow2;
						this.ctx.fill();
					}
					
					this.ctx.restore();
				} 
				else if (node.visualGlow > 0.1 && activePrimaryColor) {
					this.ctx.save();
					this.ctx.shadowBlur = node.visualGlow;
					this.ctx.shadowColor = activePrimaryColor;
					this.ctx.fill();
					this.ctx.restore();
				} else {
					this.ctx.fill();
				}
			}
			
			if (node.visualTextOpacity > 0.01) {
				this.ctx.globalAlpha = node.visualTextOpacity;

				let fillStyle = "";
				if (node.isAbsoluteCenter) {
					fillStyle = this.plugin.settings.enableColors ? GRAPH_CONSTANTS.COLORS.CENTER_NODE : GRAPH_CONSTANTS.COLORS.TEXT_WHITE; 
				} else if (this.plugin.settings.whiteLabels || isHovered || isGroupHighlight) {
					fillStyle = GRAPH_CONSTANTS.COLORS.TEXT_WHITE; 
				} else {
					fillStyle = this.resolveCSSColor(GRAPH_CONSTANTS.COLORS.TEXT_DEFAULT_VAR, GRAPH_CONSTANTS.COLORS.TEXT_FALLBACK);
				}

				let baseFontSize = node.isAbsoluteCenter 
					? (this.plugin.settings.fontSizeMax + 2) 
					: Math.max(this.plugin.settings.fontSizeMin, Math.min(this.plugin.settings.fontSizeMax, node.radius)); 

				const labelText = node.name;
				const fontStyle = node.isAbsoluteCenter ? '500' : '300';

				if (isHovered) {
					const scaledUpSize = baseFontSize * GRAPH_CONSTANTS.VISUALS.TEXT_HOVER_SCALE;
					const minScreenSizeInCanvasUnits = GRAPH_CONSTANTS.VISUALS.MIN_HOVER_TEXT_SIZE_SCREEN / this.transform.k;
					baseFontSize = Math.max(scaledUpSize, minScreenSizeInCanvasUnits);
					
					const screenPadding = GRAPH_CONSTANTS.VISUALS.TEXT_PADDING / this.transform.k;
					const yPosHover = node.y - currentRadius - screenPadding;

					this.ctx.fillStyle = fillStyle;
					this.ctx.font = `${fontStyle} ${baseFontSize}px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
					this.ctx.fillText(labelText, node.x, yPosHover);
				} else {
					const yPos = node.y - currentRadius - GRAPH_CONSTANTS.VISUALS.TEXT_PADDING;
					const scaleLevel = Math.max(1, Math.ceil(this.transform.k));
					
					const textCanvas = this.getTextCanvas(labelText, fontStyle, baseFontSize, fillStyle, scaleLevel);
					const logicalWidth = textCanvas.width / (dpr * scaleLevel);
					const logicalHeight = textCanvas.height / (dpr * scaleLevel);
					
					this.ctx.drawImage(textCanvas, node.x - logicalWidth / 2, yPos - logicalHeight / 2, logicalWidth, logicalHeight);
				}
			}

			this.ctx.globalAlpha = 1.0; 
		};

		for (const node of this.nodes) {
			if (node !== this.hoveredNode && !groupHighlightedNodes.has(node)) {
				renderNode(node, false, false);
			}
		}

		for (const node of groupHighlightedNodes) {
			renderNode(node, false, true);
		}

		if (this.hoveredNode) {
			renderNode(this.hoveredNode, true, false);
		}

		this.ctx.restore();
	}
}

// ---------------------------------------------------------
// 7. LOCAL GRAPH RENDERER (EDITOR BANNER)
// ---------------------------------------------------------

class SmartLocalGraphRenderer {
	container: HTMLElement;
	file: TFile;
	plugin: SmartGraphPlugin;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	animationFrameId: number = 0;
	
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

	constructor(container: HTMLElement, file: TFile, plugin: SmartGraphPlugin) {
		this.container = container;
		this.file = file;
		this.plugin = plugin;
		
		this.rawDragStartX = 0; // Inizializzazione esplicita per evitare alert TypeScript
		this.rawDragStartY = 0;

		this.canvas = document.createElement('canvas');
		this.canvas.style.display = 'block';
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		this.canvas.style.backgroundColor = 'transparent';
		this.container.appendChild(this.canvas);
		
		this.ctx = this.canvas.getContext('2d', { alpha: true })!;

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

	initData() {
		const graphMap = this.plugin.buildBidirectionalGraph();
		const neighbors = graphMap.get(this.file.path) || new Set();
		
		const localNodesSet = new Set([this.file.path, ...neighbors]);
		const nodeIndexMap = new Map<string, number>();

		let maxDegreeLocal = 1;
		for (const path of localNodesSet) {
			const degree = (graphMap.get(path) || new Set()).size;
			if (degree > maxDegreeLocal) maxDegreeLocal = degree;
		}

		for (const path of localNodesSet) {
			const isCenter = path === this.file.path;
			const color = this.plugin.settings.nodeColors[path] || GRAPH_CONSTANTS.COLORS.DEFAULT_NODE;
			const name = path.split('/').pop()?.replace('.md', '') || path;
			
			const globalDegree = (graphMap.get(path) || new Set()).size;
			
			let radius = this.plugin.settings.nodeMinRadius + (Math.sqrt(globalDegree) * 3.5);
			radius = Math.min(radius, this.plugin.settings.nodeMaxRadius * 0.8);
			
			if (isCenter) radius = this.plugin.settings.nodeMaxRadius * 1.0; 

			this.nodes.push({
				id: path,
				name,
				color,
				radius,
				x: isCenter ? 0 : (Math.random() - 0.5) * 200,
				y: isCenter ? 0 : (Math.random() - 0.5) * 200,
				vx: 0, vy: 0,
				isCenter,
				visualRadius: radius,
				visualOpacity: 1.0,
				visualGlow: isCenter ? 15 : 0,
				visualTextOpacity: 1.0
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
							sourceIndex,
							targetIndex,
							hoverProgress: 0,
							visualOpacity: GRAPH_CONSTANTS.VISUALS.OPACITY_BASE_LINK,
							visualWidth: this.plugin.settings.linkWidthBase
						});
					}
				}
			}
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
			const newScale = Math.max(0.2, Math.min(5, this.targetTransform.k * Math.exp(delta)));
			
			const rect = this.canvas.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			this.targetTransform.x = mouseX - (mouseX - this.targetTransform.x) * (newScale / this.targetTransform.k);
			this.targetTransform.y = mouseY - (mouseY - this.targetTransform.y) * (newScale / this.targetTransform.k);
			this.targetTransform.k = newScale;
			this.wakeUp();
		});

		this.canvas.addEventListener('mousedown', (e) => {
			this.rawDragStartX = e.clientX;
			this.rawDragStartY = e.clientY;
			const pos = getMousePos(e);
			this.draggedNode = null;
			
			for (let i = this.nodes.length - 1; i >= 0; i--) {
				const node = this.nodes[i];
				const dx = pos.x - node.x;
				const dy = pos.y - node.y;
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
		});

		this.canvas.addEventListener('mousemove', (e) => {
			if (this.draggedNode) {
				const pos = getMousePos(e);
				this.draggedNode.x = pos.x;
				this.draggedNode.y = pos.y;
				this.wakeUp(); 
			} else if (this.isDragging) {
				this.targetTransform.x = e.clientX - this.dragStartX;
				this.targetTransform.y = e.clientY - this.dragStartY;
				this.wakeUp();
			} else {
				const pos = getMousePos(e);
				let foundHover = null;
				for (let i = this.nodes.length - 1; i >= 0; i--) {
					const node = this.nodes[i];
					const dx = pos.x - node.x;
					const dy = pos.y - node.y;
					if (dx * dx + dy * dy <= Math.pow(node.radius + 3, 2)) {
						foundHover = node;
						break;
					}
				}
				
				if (foundHover !== this.hoveredNode) {
					this.hoveredNode = foundHover;
					this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
					this.wakeUp();
				}
			}
		});

		this.canvas.addEventListener('mouseup', (e) => {
			const dist = Math.abs(e.clientX - this.rawDragStartX) + Math.abs(e.clientY - this.rawDragStartY);
			if (dist < 5 && (this.draggedNode || this.hoveredNode)) {
				const targetNode = this.draggedNode || this.hoveredNode;
				if (!targetNode.isCenter) {
					const fileToOpen = this.plugin.app.vault.getAbstractFileByPath(targetNode.id);
					if (fileToOpen instanceof TFile) {
						this.plugin.app.workspace.getLeaf(false).openFile(fileToOpen);
					}
				}
			}
			this.isDragging = false;
			this.draggedNode = null;
			this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
		});

		this.canvas.addEventListener('mouseleave', () => {
			this.isDragging = false;
			this.draggedNode = null;
			this.hoveredNode = null;
			this.canvas.style.cursor = 'grab';
			this.wakeUp();
		});
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
			if (!this.canvas.isConnected) return; 

			if (!this.isSleeping) {
				this.updatePhysics();
				this.drawGraph();
			}
			this.animationFrameId = requestAnimationFrame(tick);
		};
		tick();
	}

	updatePhysics() {
		this.transform.k += (this.targetTransform.k - this.transform.k) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
		this.transform.x += (this.targetTransform.x - this.transform.x) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;
		this.transform.y += (this.targetTransform.y - this.transform.y) * GRAPH_CONSTANTS.PHYSICS.LERP_SPEED;

		const repulsion = this.plugin.settings.repulsionForce * 0.5;
		const springK = this.plugin.settings.linkStrength * 0.5;
		const springLen = this.plugin.settings.linkDistance * 1.2;

		const currentFriction = GRAPH_CONSTANTS.PHYSICS.FRICTION_IDLE + (GRAPH_CONSTANTS.PHYSICS.FRICTION_ACTIVE - GRAPH_CONSTANTS.PHYSICS.FRICTION_IDLE) * this.energy;

		for (let i = 0; i < this.nodes.length; i++) {
			const n1 = this.nodes[i];
			for (let j = i + 1; j < this.nodes.length; j++) {
				const n2 = this.nodes[j];
				const dx = n1.x - n2.x;
				const dy = n1.y - n2.y;
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
			const dx = n2.x - n1.x;
			const dy = n2.y - n1.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (dist === 0) continue;

			let force = (dist - springLen) * springK;
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;

			n1.vx += fx; n1.vy += fy;
			n2.vx -= fx; n2.vy -= fy;
		}

		let totalVelocity = 0;
		for (const node of this.nodes) {
			if (node.isCenter) {
				node.x = 0; node.y = 0; node.vx = 0; node.vy = 0;
				continue;
			}
			if (node === this.draggedNode) continue;

			const dist = Math.sqrt(node.x * node.x + node.y * node.y);
			if (dist > 0) {
				const grav = 0.01 * dist;
				node.vx -= (node.x / dist) * grav;
				node.vy -= (node.y / dist) * grav;
			}

			node.vx *= currentFriction; 
			node.vy *= currentFriction;

			if (Math.abs(node.vx) < 0.05) node.vx = 0;
			if (Math.abs(node.vy) < 0.05) node.vy = 0;

			node.x += node.vx; node.y += node.vy;
			totalVelocity += Math.abs(node.vx) + Math.abs(node.vy);
		}

		const averageVelocity = this.nodes.length > 0 ? totalVelocity / this.nodes.length : 0;

		if (averageVelocity < GRAPH_CONSTANTS.PHYSICS.SLEEP_VELOCITY_THRESHOLD) {
			this.energy *= GRAPH_CONSTANTS.PHYSICS.ENERGY_DECAY;
			if (this.energy < 0.05) {
				this.stableFrames++;
				if (this.stableFrames > 15) {
					this.isSleeping = true;
					this.energy = 0;
					for (const node of this.nodes) {
						node.vx = 0;
						node.vy = 0;
					}
				}
			}
		} else {
			this.stableFrames = 0;
			if (this.draggedNode) {
				this.energy = 1.0;
			} else {
				this.energy = Math.min(1.0, this.energy + 0.05);
			}
		}
	}

	drawGraph() {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		const dpr = window.devicePixelRatio || 1;
		this.ctx.scale(dpr, dpr); 
		
		this.ctx.translate(this.transform.x, this.transform.y);
		this.ctx.scale(this.transform.k, this.transform.k);

		this.ctx.textAlign = "center";
		this.ctx.textBaseline = "middle";

		const visFactor = 0.2; 

		// Edges
		for (const edge of this.edges) {
			const n1 = this.nodes[edge.sourceIndex];
			const n2 = this.nodes[edge.targetIndex];

			const isHovered = this.hoveredNode === n1 || this.hoveredNode === n2;
			edge.hoverProgress = isHovered 
				? Math.min(1.0, edge.hoverProgress + 0.1) 
				: Math.max(0.0, edge.hoverProgress - 0.1);

			this.ctx.beginPath();
			this.ctx.moveTo(n1.x, n1.y);
			this.ctx.lineTo(n2.x, n2.y);
			
			this.ctx.strokeStyle = `rgba(150, 150, 150, ${this.plugin.settings.enableColors ? 0.3 : 0.6})`;
			this.ctx.lineWidth = this.plugin.settings.linkWidthBase / this.transform.k;
			this.ctx.stroke();

			if (edge.hoverProgress > 0) {
				this.ctx.save();
				this.ctx.globalAlpha = edge.hoverProgress;
				this.ctx.strokeStyle = "var(--color-purple)"; 
				this.ctx.lineWidth = this.plugin.settings.linkWidthHover / this.transform.k;
				this.ctx.stroke();
				this.ctx.restore();
			}
		}

		// Nodes
		for (const node of this.nodes) {
			const isHovered = this.hoveredNode === node;
			let targetRadius = isHovered ? node.radius * 1.2 : node.radius;

			node.visualRadius += (targetRadius - node.visualRadius) * visFactor;
			node.visualOpacity += ((isHovered || !this.hoveredNode ? 1.0 : 0.4) - node.visualOpacity) * visFactor;

			this.ctx.globalAlpha = node.visualOpacity;
			this.ctx.beginPath();
			this.ctx.arc(node.x, node.y, node.visualRadius, 0, 2 * Math.PI, false);

			const activeColor = this.plugin.settings.enableColors ? node.color : GRAPH_CONSTANTS.COLORS.DEFAULT_NODE;
			
			if (node.isCenter) {
				this.ctx.fillStyle = activeColor;
				this.ctx.fill();
				
				if (this.plugin.settings.enableGlow) {
					this.ctx.save();
					this.ctx.shadowBlur = 15;
					this.ctx.shadowColor = activeColor;
					this.ctx.strokeStyle = "rgba(255,255,255,0.5)";
					this.ctx.lineWidth = 2 / this.transform.k;
					this.ctx.stroke();
					this.ctx.restore();
				}
			} else {
				this.ctx.fillStyle = activeColor;
				this.ctx.fill();
			}

			// Text
			const showText = this.plugin.settings.showAllLabels || isHovered || node.isCenter;
			node.visualTextOpacity += ((showText ? 1.0 : 0.0) - node.visualTextOpacity) * visFactor;

			if (node.visualTextOpacity > 0.05) {
				this.ctx.globalAlpha = node.visualTextOpacity * node.visualOpacity;
				const fontSize = Math.max(this.plugin.settings.fontSizeMin, Math.min(this.plugin.settings.fontSizeMax, node.radius));
				const yPos = node.y - node.visualRadius - 8;

				this.ctx.fillStyle = (this.plugin.settings.whiteLabels || isHovered) ? "#fff" : "var(--text-normal)";
				this.ctx.font = `${node.isCenter ? '600' : '300'} ${isHovered ? fontSize * 1.2 : fontSize}px "Inter", sans-serif`;
				this.ctx.fillText(node.name, node.x, yPos);
			}
			this.ctx.globalAlpha = 1.0;
		}

		this.ctx.restore();
	}
}