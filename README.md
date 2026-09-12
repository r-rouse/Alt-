# PageGuide

> **Conversational Image Accessibility for Blind and Low-Vision Users**  
> *Alt text tells a blind user what the website author decided to describe. PageGuide lets the user explore visual information for themselves.*

PageGuide is a Chrome extension (Manifest V3) that makes visual information accessible, interactive, and conversational. It identifies meaningful images with missing or inadequate descriptions, leverages vision-capable AI grounded in the webpage's semantic context, augments the browser's accessibility tree for screen readers (VoiceOver, NVDA, JAWS), and enables users to **have a direct conversation with any image**.

Alongside conversational vision, PageGuide preserves an autonomous runtime accessibility repair layer for missing labels, broken keyboard access, and non-semantic controls.

---

## The Core Product Idea

Traditional screen readers depend heavily on image alt text.

Without PageGuide:
```html
<img src="wildfire-map.jpg">
```
Announced by VoiceOver simply as:
```text
"image"
```

Even when author alt text exists, it is often uninformative:
```html
<img src="wildfire-map.jpg" alt="map">
```
Announced as:
```text
"map, image"
```

With **PageGuide**:
1. PageGuide inspects the image in the context of the page (page title, section heading, caption, nearby paragraphs).
2. It generates a high-value, contextual description and augments the DOM so VoiceOver immediately announces:
   ```text
   "Map of Northern California showing several active wildfire areas. The largest concentration appears northeast of Sacramento. (PageGuide description available)"
   ```
3. **The user can then converse directly with the image**:
   - User: *"Describe this image in detail."*
   - PageGuide: *"The map displays Northern California with several highlighted wildfire regions. The largest concentration is northeast of Sacramento, with smaller zones near Redding..."*
   - User: *"What's happening near Sacramento?"*
   - PageGuide: *"Northeast of Sacramento, approximately 45,000 acres are marked with active containment lines..."*
   - User: *"Does it show any highways?"*
   - PageGuide: *"Yes, Interstate 80 passes south of the primary fire perimeter..."*

The image becomes an **interactive information source**.

---

## Architecture

```text
                  ┌─────────────────────┐
                  │   Chrome Webpage    │
                  │                     │
                  │ Images + DOM        │
                  └─────────┬───────────┘
                            │
                     Content Script
                            │
                            ▼
                  ┌─────────────────────┐
                  │     PageGuide       │
                  │                     │
                  │ Image Registry      │
                  │ Page Context        │
                  │ Accessibility Scan  │
                  │ Active Image State  │
                  └─────────┬───────────┘
                            │
                    Agent / UI Bridge
                            │
                     (AG-UI Pattern)
                            │
                            ▼
                  ┌─────────────────────┐
                  │   PageGuide Agent   │
                  │                     │
                  │ Intent reasoning    │
                  │ Tool selection      │
                  │ Conversation state  │
                  └─────────┬───────────┘
                            │
                   Vision Provider Layer
                            │
                  ┌─────────┴──────────┐
                  ▼                    ▼
               OpenAI             OpenRouter
             (PRIMARY)            (OPTIONAL)
                  │
                  ▼
           Vision Understanding
                  │
          ┌───────┴─────────┐
          ▼                 ▼
     Description       Browser Action
    (Quick/Detailed)       Tools
```

### Agent / UI Bridge (AG-UI Architecture)
PageGuide implements the **Agent-User Interface (AG-UI)** bridge pattern (`src/agent/agentBridge.ts`).
- **Shared Reactive Agent State (`PageGuideAgentState`)**:
  - `page`: Current title and URL
  - `images`: Live list of scanned `PageImage` records
  - `activeImageId`: The image currently active in conversation
  - `inaccessibleImageCount`: Number of images missing alt or with poor descriptions
  - `repairsEnabled`: Boolean flag for runtime accessibility repairs
- **Constrained Frontend Agent Tools**:
  - `getPageContext()`: Returns summary of page and images
  - `getImages()`: Returns all images on page
  - `getActiveImage()`: Returns currently selected image
  - `setActiveImage(imageId)`: Changes active image context
  - `focusImage(imageId)`: Moves browser focus and scroll position
  - `describeImage(imageId, mode)`: Generates quick or detailed description
  - `askImageQuestion(imageId, question)`: Answers follow-up questions
  - `applyImageDescription(imageId)`: Sets `aria-label` and `alt` in DOM
  - `nextImage()`: Steps to the next image on the page
  - `previousImage()`: Steps to the previous image on the page
- **Architectural Note on CopilotKit**:
  CopilotKit standard packages rely on an external Node/Next.js backend (`CopilotRuntime`) to stream completions. To maintain a standalone, offline-ready Chrome Extension (Manifest V3) without external server dependencies, PageGuide implements the AG-UI agent bridge natively within the extension.

### Vision Provider Layer (`src/agent/visionProvider.ts`)
Decouples visual understanding from API implementation details:
- **`VisionProvider` Interface**:
  - `describeImage(image, context, mode): Promise<ImageDescription>`
  - `askImageQuestion(image, context, question, conversation): Promise<ImageAnswer>`
- **`OpenAIVisionProvider` (Primary / Default)**: Uses `gpt-4o-mini` with vision and specialized system instructions for charts, maps, and text.
- **`OpenRouterVisionProvider` (Optional)**: Drop-in alternative routing vision requests through OpenRouter.
- **`VisionService`**: Single central service consumed by the rest of the application. Switchable at runtime via the Settings panel or `VISION_PROVIDER` environment variable.

---

## Key Capabilities

### 1. Context-Aware Descriptions
An image of a bicycle in a municipal infrastructure report is described in terms of protected bike lanes and street traffic separators. The same bicycle in an e-commerce shop is described by its frame geometry, disc brakes, and components. PageGuide instructs the vision model with the surrounding heading, caption, and article text.

### 2. High-Value Visual Explanations (Charts & Maps)
- **Charts & Graphs**: Identifies chart type, title, axes, units, overall trend, peaks, lows, anomalies, and policy interventions. Honest about uncertainty: says *"approximately"* for interpolated values rather than hallucinating.
- **Maps**: Identifies geographic region, highlighted corridors, river crossings, routes, landmarks, and legend categories.
- **Text in Images**: Reads visible signs, banners, and street labels directly.

### 3. Screen Reader Augmentation (Reversible)
When a quick description is generated, PageGuide sets `aria-label` and `alt` on the live DOM element with a `(PageGuide description available)` suffix. Changes are tracked and reversible via the `PageGuide Repairs: OFF / ON` toggle.

### 4. Audio-First Interface & Voice Interaction
- **TTS (Text-to-Speech)**: Speaks descriptions and answers aloud automatically, with `Escape` to silence instantly.
- **Synthesized Web Audio Earcons**: Rising/falling chimes for scan start/complete, focus shifts, repair toggles, and image descriptions.
- **Hands-Free Voice (`Alt + M` / `Option + M`)**: Speech-to-text powered by OpenAI Whisper (`whisper-1`) with Web Speech API fallback.

---

## Primary Hackathon Demo (Step-by-Step)

The project includes an image-heavy demonstration page themed around the **Portland Transportation Report 2026**:

- **File**: `demo/portland-transportation.html` (bundled into `dist/demo/portland-transportation.html`).

### Step 1: The "Before" Experience
1. Open `demo/portland-transportation.html` in Chrome.
2. Turn on VoiceOver (`Cmd + F5` on macOS).
3. Tab through the page:
   - Image 1 (Street photo): VoiceOver announces `"image"`.
   - Image 2 (Bikeway map): VoiceOver announces `"image"`.
   - Image 3 (Safety chart): VoiceOver announces `"chart, image"`.
   - Visual information is completely inaccessible.

### Step 2: Activate PageGuide
1. Click the PageGuide extension icon to open the Side Panel.
2. PageGuide automatically scans the images:
   ```text
   4 images detected. 1 has a useful description, 3 may need descriptions.
   ```
3. Notice that Image 4 (decorative divider with `alt=""`) is correctly recognized as decorative and left alone.

### Step 3: Interactive Conversation with Image 2 (The Map)
1. In the side panel or by focusing the map, select **Image 2 (pg-img-2)**.
2. Click **⚡ Quick Alt** or ask via voice (`Alt + M`): *"Describe this image"*.
   - PageGuide generates a contextual description explaining the Willamette River divider, bridges, and Eastside bike corridors.
3. Follow up: *"Tell me more"*.
   - PageGuide provides detailed layout of the Hawthorne Bridge, Tilikum Crossing, and Central Eastside hub.
4. Follow up: *"What's happening on the east side?"*.
   - PageGuide explains the heavy concentration of greenways along SE Hawthorne, SE Division, and SE Clinton.

### Step 4: Interactive Conversation with Image 3 (The Chart)
1. Select **Image 3 (pg-img-3)**.
2. Ask: *"What does this chart show?"*.
   - PageGuide explains the annual collision trend from 2020 through 2025.
3. Follow up: *"What year was the worst?"*.
   - PageGuide answers: *"The worst year was 2022, reaching a peak of 4,850 reported collisions, before dropping 55% by 2025 following automated camera interventions."*

### Step 5: The "After" Screen Reader Experience
1. Navigate back to the images in VoiceOver.
2. VoiceOver now reads the full PageGuide description:
   ```text
   "Portland Vision Zero collision trend chart showing annual incidents declining from a 2022 peak of 4,850 down to 2,200 in 2025. (PageGuide description available)"
   ```
3. This delivers the critical **Before / After** accessible transformation.

---

## Setup & Development

### 1. Install & Build

```bash
npm install
npm run build
```

This compiles:
- The React / Vite side panel into `dist/sidepanel.html` and assets.
- `src/content/contentScript.ts` into a standalone bundle `dist/contentScript.js`.
- `src/background/background.ts` into `dist/background.js`.
- Copies `manifest.json`, icons, and the `demo/` suite into `dist/`.

### 2. Configure OpenAI API Key
- Option A: Create a `.env` file with `VITE_OPENAI_API_KEY=sk-...` and run `npm run build`.
- Option B: Open the PageGuide Side Panel in Chrome, click **⚙ Settings**, paste your key, and click **Save key** (stored locally in `chrome.storage.local`).

### 3. Load Extension in Chrome
1. Open `chrome://extensions`.
2. Enable **Developer mode** (toggle in upper-right).
3. Click **Load unpacked** and select the `dist/` folder in this repository.
4. Pin the **PageGuide** extension icon to your Chrome toolbar.
5. Open `dist/demo/portland-transportation.html` or `demo/portland-transportation.html` and click the PageGuide icon.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Alt + M` (Mac: `Option + M`) | Activate hands-free voice input / microphone |
| `Escape` | Immediately silence spoken audio (TTS) and voice recognition |
| `Enter` (in composer) | Send message / question to active image or page agent |
| `Shift + Enter` | Insert newline in message input |

---

## File Structure

```text
forEyes/
├── manifest.json              # Chrome Manifest V3 configuration
├── demo/
│   ├── portland-transportation.html # Image-heavy accessibility demo page
│   ├── street-scene.svg       # Image 1: Street photo (missing alt)
│   ├── bike-network-map.svg   # Image 2: Bike network map (missing alt)
│   ├── collision-chart.svg    # Image 3: Vision Zero chart (alt="chart")
│   └── decorative-divider.svg # Image 4: Decorative graphic (alt="")
├── src/
│   ├── shared/
│   │   ├── images.ts          # PageImage, ImageScanSummary, conversation types
│   │   ├── accessibility.ts   # Deterministic issue and repair types
│   │   └── messages.ts        # Typed extension IPC messages
│   ├── content/
│   │   ├── imageScanner.ts    # Image discovery, heuristics, canvas/proxy extraction
│   │   ├── accessibilityScanner.ts # Deterministic page barrier scanner
│   │   ├── repairEngine.ts    # Reversible attribute modification engine
│   │   └── contentScript.ts   # Content script entry & message dispatcher
│   ├── background/
│   │   └── background.ts      # Side panel routing & CORS-free image fetch proxy
│   ├── agent/
│   │   ├── visionAgent.ts     # GPT-4o-mini Vision (quick, detailed, interactive Q&A)
│   │   ├── agent.ts           # Natural-language agent loop with tool calling
│   │   ├── tools.ts           # Tool schemas (describeActiveImage, askAboutImage, etc.)
│   │   └── systemPrompt.ts    # Vision and accessibility agent system instructions
│   └── sidepanel/
│       ├── App.tsx            # Side panel React UI (Image-first tabs, cards, chat)
│       ├── audioService.ts    # Web Audio earcons, TTS synthesizer, Whisper STT
│       └── styles.css         # High-contrast accessible styling & image cards
```

---

## License

MIT License. Designed for hackathons, assistive technology evaluations, and accessible web research.
# Alt-
