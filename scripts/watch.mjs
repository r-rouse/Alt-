import { spawn } from "child_process";

/** Simple rebuild-on-change for hackathon iteration */
const run = () =>
  spawn("npm", ["run", "build"], { stdio: "inherit", shell: true });

run();

const watcher = spawn(
  "npx",
  ["vite", "build", "--watch"],
  { stdio: "inherit", shell: true }
);

process.on("SIGINT", () => {
  watcher.kill();
  process.exit(0);
});
