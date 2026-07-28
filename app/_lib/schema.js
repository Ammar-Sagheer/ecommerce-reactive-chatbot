export const SCHEMA_DESCRIPTION = `
You may query ONLY the following tables (read-only product catalog data):

TABLE categories (
  id integer PRIMARY KEY,
  name varchar,
  slug varchar UNIQUE,
  image_url text NULL,
  created_at timestamptz
)

TABLE products (
  id integer PRIMARY KEY,
  name varchar,
  slug varchar UNIQUE,
  description text NULL,
  price numeric,
  sale_price numeric NULL,      -- discounted price, NULL if not on sale
  category_id integer NULL REFERENCES categories(id),
  stock integer,                -- units available; 0 means out of stock
  is_featured boolean,
  rating numeric,               -- customer rating out of 5
  created_at timestamptz
)

TABLE product_images (
  id integer PRIMARY KEY,
  product_id integer REFERENCES products(id),
  image_url text,
  display_order integer
)

Rules:
- Only SELECT statements are allowed. Never write INSERT/UPDATE/DELETE/DDL.
- Only reference the three tables above. No other tables exist for you.
- Use sale_price when present as the effective price, otherwise price.
- Always add a reasonable LIMIT (<=20) unless the user asks for a count/aggregate.
- Always include a product's slug column in SELECT queries that return products, so it can be
  linked to. To link a visitor to a product page, build the path /products/<slug>. Never present
  product_images.image_url as a link to the product itself — that is only a picture, not a page.
`;

export const ALLOWED_TABLES = new Set(["products", "categories", "product_images"]);
