/**
 * Order-item ↔ plugin-storage mapping.
 *
 * EmDash declares `product_variants.uniqueIndexes: ["sku"]` as a table-wide
 * expression index on `_plugin_storage(plugin_id, collection, $.sku)`.
 * That makes `sku` unique *within each collection*, not only among variants.
 *
 * Order items historically wrote `sku: ""` (and would write the same catalog
 * SKU on every repurchase). A second paid order then failed putMany with:
 *   UNIQUE constraint failed: index 'uidx_plugin_dashcommerce_product_variants_sku'
 * which surfaced as a 500 on `checkout.session.completed` after the order
 * row had already been inserted — the hosted PI/session race symptom.
 *
 * Persist catalog SKUs under `productSku` instead; never write `sku` on
 * order_items documents.
 */

import type { OrderItem } from "../types";

export type OrderItemStorageRow = Omit<OrderItem, "sku"> & {
	productSku?: string;
	/** @deprecated Legacy rows may still carry this; readers map it to sku. */
	sku?: string;
};

export function orderItemToStorage(item: OrderItem): OrderItemStorageRow {
	const { sku, ...rest } = item;
	if (sku && sku.trim() !== "") {
		return { ...rest, productSku: sku };
	}
	return { ...rest };
}

export function orderItemFromStorage(
	id: string,
	data: OrderItemStorageRow | OrderItem,
): OrderItem {
	const row = data as OrderItemStorageRow;
	const sku =
		(typeof row.productSku === "string" && row.productSku) ||
		(typeof row.sku === "string" && row.sku) ||
		"";
	const { productSku: _productSku, sku: _sku, ...rest } = row;
	return {
		...(rest as Omit<OrderItem, "id" | "sku">),
		id,
		sku,
	};
}
