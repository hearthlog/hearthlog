/** Czech flat-rate (paušál) tax assumptions, shared by the income calculator and invoice analytics. */
export const taxConfig = {
	flatRate: 0.6,
	incomeTax: 0.15,
	socialInsuranceBase: 0.55,
	medicalInsuranceBase: 0.5,
	socialInsurance: 0.292,
	medicalInsurance: 0.135,
	incomeTaxDiscount: 30_840,
	maxTariff: 2_000_000,
} as const;

export type TaxConfig = typeof taxConfig;

export function deriveTaxRates(config: TaxConfig = taxConfig) {
	const taxBase = 1 - config.flatRate;
	const totalTaxRateWithoutTariff =
		config.incomeTax +
		config.socialInsuranceBase * config.socialInsurance +
		config.medicalInsuranceBase * config.medicalInsurance;
	return {
		taxBase,
		totalTaxRateWithoutTariff,
		totalTaxRate: taxBase * totalTaxRateWithoutTariff,
	} as const;
}

const taxDerived = deriveTaxRates(taxConfig);

/** Annual tax estimate from a year's gross (net-of-VAT) earnings. */
export type AnnualTaxSummary = {
	totalEarnings: number;
	/** Income tax after the annual taxpayer discount; never negative. */
	incomeTax: number;
	socialInsurance: number;
	medicalInsurance: number;
	/** incomeTax + socialInsurance + medicalInsurance. */
	totalTaxes: number;
	afterTaxEarnings: number;
	/** totalTaxes / totalEarnings, or 0 without earnings. */
	effectiveRate: number;
};

/**
 * Applies the flat-rate regime used by the calculator to actual annual
 * revenue: 60% expense allowance up to the tariff cap, then income tax,
 * social and medical insurance. The discount only reduces income tax; an
 * unused remainder never lowers insurance or creates a negative tax.
 */
export function summarizeAnnualEarnings(
	totalEarnings: number,
	config: TaxConfig = taxConfig,
): AnnualTaxSummary {
	const derived = config === taxConfig ? taxDerived : deriveTaxRates(config);
	const earnings =
		Number.isFinite(totalEarnings) && totalEarnings > 0 ? totalEarnings : 0;

	// Amounts over the tariff cap get no flat-rate deduction.
	const earningsUnderTariff = Math.min(earnings, config.maxTariff);
	const earningsOverTariff = Math.max(0, earnings - config.maxTariff);
	const taxableBase = earningsUnderTariff * derived.taxBase + earningsOverTariff;

	const socialInsurance =
		taxableBase * config.socialInsuranceBase * config.socialInsurance;
	const medicalInsurance =
		taxableBase * config.medicalInsuranceBase * config.medicalInsurance;
	const incomeTax = Math.max(
		0,
		taxableBase * config.incomeTax - config.incomeTaxDiscount,
	);
	const totalTaxes = incomeTax + socialInsurance + medicalInsurance;
	const afterTaxEarnings = earnings - totalTaxes;

	return {
		totalEarnings: earnings,
		incomeTax,
		socialInsurance,
		medicalInsurance,
		totalTaxes,
		afterTaxEarnings,
		effectiveRate: earnings > 0 ? totalTaxes / earnings : 0,
	};
}

export type TaxSummary = {
	totalEarnings: number;
	afterTaxEarnings: number;
	totalTaxes: number;
	salary: number;
	taxes: number;
	incomeTax: number;
	socialInsurance: number;
	medicalInsurance: number;
	incomeTaxMonthly: number;
	socialInsuranceMonthly: number;
	medicalInsuranceMonthly: number;
	netSalary: number;
};

/**
 * Project annual revenue from man-days and day rate, then estimate after-tax
 * earnings under the configured flat-rate regime (including tariff cap).
 */
export function calculateSummary(
	mdCountValue: number,
	mdRateValue: number,
	config: TaxConfig = taxConfig,
): TaxSummary {
	const count = Number(mdCountValue) || 0;
	const rate = Number(mdRateValue) || 0;
	const totalEarnings = count * rate * 12;
	const annual = summarizeAnnualEarnings(totalEarnings, config);

	return {
		totalEarnings,
		afterTaxEarnings: annual.afterTaxEarnings,
		totalTaxes: annual.totalTaxes,
		salary: annual.afterTaxEarnings / 12,
		taxes: annual.totalTaxes / 12,
		// Breakdown components (yearly)
		incomeTax: annual.incomeTax,
		socialInsurance: annual.socialInsurance,
		medicalInsurance: annual.medicalInsurance,
		// Breakdown components (monthly)
		incomeTaxMonthly: annual.incomeTax / 12,
		socialInsuranceMonthly: annual.socialInsurance / 12,
		medicalInsuranceMonthly: annual.medicalInsurance / 12,
		netSalary: annual.afterTaxEarnings / 12,
	};
}
