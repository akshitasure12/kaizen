const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function Home() {
  return (
    <main>
      <h1>Kaizen</h1>
      <p>
        Frontend scaffold. API base: <code>{apiUrl}</code> (from{" "}
        <code>NEXT_PUBLIC_API_URL</code>).
      </p>
    </main>
  );
}
