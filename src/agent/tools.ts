/**
 * OpenAI tool / function definitions for constrained browser actions.
 */

import type { AgentToolName } from "../shared/types";

export interface ToolDefinition {
  type: "function";
  function: {
    name: AgentToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "getPageStructure",
      description: "Rebuild and return the semantic structure of the current webpage.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "listInteractiveElements",
      description: "List interactive elements with PageGuide IDs and labels.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getAccessibilityIssues",
      description: "List accessibility issues detected by PageGuide on the current page.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getAppliedRepairs",
      description: "List runtime accessibility repairs PageGuide has applied.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getSection",
      description: "Get the text content of an element and its subtree by PageGuide ID.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "PageGuide element ID such as pg-14" },
        },
        required: ["elementId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "focusElement",
      description:
        "Move keyboard focus to an element without activating it. Use when user explicitly asks to locate, highlight, inspect, or move focus to a field, control, or section.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "PageGuide element ID such as pg-14" },
        },
        required: ["elementId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clickElement",
      description:
        "Activate, click, or follow a link, button, or interactive control. Use whenever the user asks to open, go to, navigate to, follow, click, or activate an element (e.g. 'Take me to pricing', 'Open the second option', 'Click register', 'Go to about us'). Set confirmed=true only after explicit user confirmation of high-impact destructive actions (like delete, purchase).",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "PageGuide element ID such as pg-14" },
          confirmed: { type: "boolean" },
        },
        required: ["elementId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scrollToElement",
      description: "Scroll an element into view without moving focus. Prefer focusElement.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
        },
        required: ["elementId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getElementText",
      description: "Read the visible text of a specific element by PageGuide ID.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
        },
        required: ["elementId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fillInput",
      description: "Fill a text input, textarea, or select. Never use for password fields.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          value: { type: "string" },
        },
        required: ["elementId", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "openNewTab",
      description:
        "Open a link or webpage in a new browser tab and make it the active tab. When opening an existing link from the current page (e.g., 'Open the application in a new tab', 'Open pricing in another tab', 'Open that link in a new tab'), ALWAYS provide elementId (such as pg-42) so the URL is deterministically resolved from the webpage without inventing or guessing URLs. Only provide url if the user explicitly dictated an external web address.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description:
              "PageGuide element ID of a link on the page (e.g. pg-42). Preferred over url for page links.",
          },
          url: {
            type: "string",
            description:
              "Direct absolute web URL starting with https:// or http://. Only provide if user dictated an address.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getOpenTabs",
      description:
        "List all currently open browser tabs in the window, returning tab IDs, titles, URLs, and which tab is currently active. Use when the user asks 'What tabs do I have open?', 'Show my tabs', or before switching tabs to find the target tab ID.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "switchTab",
      description:
        "Switch the active browser tab to a specified tab. Use when the user asks to switch or go back to another tab (e.g., 'Switch back', 'Go back to the article', 'Go to the application tab'). If you don't know the tabId yet, call getOpenTabs first.",
      parameters: {
        type: "object",
        properties: {
          tabId: {
            type: "number",
            description: "The numeric tab ID to switch to, obtained from getOpenTabs.",
          },
        },
        required: ["tabId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "closeTab",
      description:
        "Close a browser tab. If tabId is omitted, closes the currently active tab. Use when the user says 'Close this tab' or 'Close the tab'.",
      parameters: {
        type: "object",
        properties: {
          tabId: {
            type: "number",
            description: "Optional tab ID to close. If omitted, closes the currently active tab.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listImages",
      description:
        "List all images on the page with their PageGuide image IDs, alt text status (missing, poor, good, decorative), and nearest headings.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "describeActiveImage",
      description:
        "Inspect an image with OpenAI Vision and return a context-aware description. If imageId is omitted, inspects the currently active/focused image.",
      parameters: {
        type: "object",
        properties: {
          imageId: {
            type: "string",
            description: "Optional PageGuide image ID (e.g. pg-img-1)",
          },
          mode: {
            type: "string",
            enum: ["quick", "detailed"],
            description: "quick for concise alt text; detailed for comprehensive explanation",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "askAboutImage",
      description:
        "Ask a specific question about an image (e.g. 'What does this chart show?', 'What is happening near Sacramento?', 'Read the text in the image').",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question to ask about the image" },
          imageId: { type: "string", description: "Optional image ID (uses active image if omitted)" },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "focusImage",
      description: "Move keyboard focus and scroll to an image element on the page.",
      parameters: {
        type: "object",
        properties: {
          imageId: { type: "string", description: "PageGuide image ID (e.g. pg-img-2)" },
        },
        required: ["imageId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getPageContext",
      description:
        "Get current page title, URL, image count, inaccessible image count, and currently active image ID.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getImages",
      description:
        "Retrieve all images on the page with their IDs, alt text, context, and accessibility status.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "getActiveImage",
      description:
        "Get the currently selected/active image context for the conversation.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "setActiveImage",
      description:
        "Set the active image for subsequent questions and conversation.",
      parameters: {
        type: "object",
        properties: {
          imageId: { type: "string", description: "PageGuide image ID (e.g. pg-img-1)" },
        },
        required: ["imageId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describeImage",
      description:
        "Inspect an image with vision and return a context-aware description. Uses active image if imageId is omitted.",
      parameters: {
        type: "object",
        properties: {
          imageId: { type: "string", description: "Optional image ID" },
          mode: {
            type: "string",
            enum: ["quick", "detailed"],
            description: "quick for concise screen reader alt text; detailed for in-depth breakdown",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "askImageQuestion",
      description:
        "Ask a specific question about an image (e.g. 'What does this chart show?', 'Read the sign', 'What is near the river?'). Uses active image if omitted.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask about the image" },
          imageId: { type: "string", description: "Optional image ID" },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "applyImageDescription",
      description:
        "Apply the generated description to the image in the live DOM as an accessibility augmentation for VoiceOver/screen readers.",
      parameters: {
        type: "object",
        properties: {
          imageId: { type: "string", description: "PageGuide image ID" },
        },
        required: ["imageId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nextImage",
      description: "Navigate to and focus the next image on the webpage.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "previousImage",
      description: "Navigate to and focus the previous image on the webpage.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];
