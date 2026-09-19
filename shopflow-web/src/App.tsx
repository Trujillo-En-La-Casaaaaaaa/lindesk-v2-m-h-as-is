import { useEffect, useState, type FormEvent } from "react";
import { api, type Order, type Product } from "./api";

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [email, setEmail] = useState("buyer@example.com");
  const [lookup, setLookup] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");

  const refreshProducts = () => api.products().then((items) => {
    setProducts(items);
    setSelected((value) => value || items[0]?.id || "");
  }).catch((cause: Error) => setError(cause.message));

  useEffect(() => { void refreshProducts(); }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const created = await api.createOrder({ productId: selected, quantity, customerEmail: email });
      setOrder(created);
      setLookup(created.id);
      refreshProducts();
    } catch (cause) { setError((cause as Error).message); }
  }

  async function find(event: FormEvent) {
    event.preventDefault();
    setError("");
    try { setOrder(await api.order(lookup)); } catch (cause) { setError((cause as Error).message); }
  }

  async function ship() {
    if (!order) return;
    setError("");
    try { setOrder(await api.shipOrder(order.id)); } catch (cause) { setError((cause as Error).message); }
  }

  return <main>
    <header><p className="eyebrow">THESIS FIXTURE · F2</p><h1>ShopFlow</h1><p>Deterministic catalog, inventory, and order fulfillment.</p></header>
    {error && <p role="alert" className="error">{error}</p>}
    <section><h2>Catalog</h2><div className="catalog">
      {products.map((product) => <article key={product.id}>
        <span className="sku">{product.sku}</span><h3>{product.name}</h3>
        <strong>${(product.priceCents / 100).toFixed(2)}</strong><p>{product.stock} in stock</p>
      </article>)}
    </div></section>
    <section><h2>Create order</h2><form onSubmit={create}>
      <label>Product<select value={selected} onChange={(event) => setSelected(event.target.value)}>
        {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select></label>
      <label>Quantity<input type="number" min="1" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}/></label>
      <label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)}/></label>
      <button type="submit">Place order</button>
    </form></section>
    <section><h2>Order detail / Admin</h2><form className="lookup" onSubmit={find}>
      <label>Order ID<input required value={lookup} onChange={(event) => setLookup(event.target.value)}/></label>
      <button type="submit">Find</button>
    </form>
    {order && <div className="order">
      <p><b>ID</b> {order.id}</p><p><b>Status</b> <span className="status">{order.status}</span></p>
      <p><b>Quantity</b> {order.quantity}</p><p><b>Total</b> ${(order.totalCents / 100).toFixed(2)}</p>
      {order.status === "CONFIRMED" && <button onClick={ship}>Mark SHIPPED</button>}
    </div>}</section>
  </main>;
}
