process.env.NODE_ENV = "test";
process.env.SOY_OWNER_CLERK_USER_ID = "test-owner";

async function main() {
  const { createServer } = await import("node:http");
  const { default: app } = await import("./artifacts/api-server/src/app.ts");

  const port = Number(process.env.TEST_PORT ?? "18082");
  const server = createServer(app);

  server.listen(port, "127.0.0.1", () => {
    console.log(`SOY_P1_TEST_SERVER_READY http://127.0.0.1:${port}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
