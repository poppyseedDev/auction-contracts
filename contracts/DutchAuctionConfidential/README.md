# Confidential Dutch Auction Contract

A privacy-preserving Dutch auction implementation for selling confidential ERC20 tokens, built using fhEVM (Fully Homomorphic Encryption Virtual Machine).

## Overview

This contract implements a Dutch auction mechanism where:
- The price starts high and decreases linearly over time
- Token amounts and payments are encrypted using FHE
- Users can bid multiple times, with later bids taking advantage of lower prices
- Unused payments from earlier bids can be applied to new token purchases

## Key Features

- **Privacy Preservation**: All token amounts and payments are encrypted
- **Dynamic Pricing**: Price decreases linearly from starting price to reserve price
- **Flexible Bidding**: Users can bid multiple times as prices decrease
- **Automatic Refunds**: Excess payments are automatically refunded at auction end
- **Manual Stop Option**: Auctions can be configured to be manually stoppable
- **Owner Controls**: Owner can initialize, stop (if enabled), and cancel the auction

## How It Works

1. **Initialization**:
   - Owner sets starting price, discount rate, reserve price, and token amounts
   - Owner transfers auction tokens to the contract

2. **Bidding**:
   - Users can bid at any time during the auction
   - Price decreases linearly over time until reaching reserve price
   - If the user did the bid in the past, but now the token price has gone down, and they want to buy more tokens, they can use some of the refundable paymentToken towards buying more tokens

3. **Claiming**:
   - After auction ends, users can claim their tokens and any refunds
   - Seller can claim proceeds and unsold tokens

## Mathematics

**Basic formula for price calculation:**
```
price = token_amount * token_price
```

### Variable Definitions
 - P1 := price at point 1
 - P2 := price at point 2
 - TA1 := token amount at point 1
 - TA2 := token amount at point 2
 - TP1 := token price at point 1
 - TP2 := token price at point 2
 - P_A1P2 := tokens bought at point 1 priced at point 2 
 - EP := end price or total price you have to pay
 - R := refund price
 - TA := total token amount
 - X := amount that needs to be refunded or the amount which needs to paid

### Key Equations

1. **Token Amount Relationship**
```
TA = TA1 + TA2    // Total tokens is sum of bid amounts
```

2. **Price Calculations**
```
P1 = TA1 * TP1    // First bid price
P2 = TA2 * TP2    // Second bid price
EP = TA * TP2     // Final price at lower rate
   = (TA1 + TA2) * TP2
```

3. **Price Adjustment Calculation**
```
X = EP - P1       // Adjustment needed to reconcile prices
  = (TA1 * TP2 + TA2 * TP2) - (TA1 * TP1)
```

### Calculating the Adjustment (X)


The adjustment amount X is calculated as:
`P1 + X = EP`

Therefore:
```
X = EP - P1
X = TA1 * TP2 + TA2 * TP2 - TA1 * TP1
```

If X > 0: Additional payment is required which equals:
```
X = | P_A1P2 + P2 - P1 |
X = | TA1 * TP2 + TA2 * TP2 - TA1 * TP1 |
```

If X < 0: Refund amount that is due to the user:
```
X = | P1 - (P_A1P2 + P2) |
X = | TA1 * TP1 - TA1 * TP2 - TA2 * TP2 |
```

## Functions

### Core Functions
- `initialize()`: Start the auction
- `bid(einput encryptedValue, bytes calldata inputProof)`: Submit a bid
- `claimUser()`: Claim tokens and refunds after auction
- `claimSeller()`: Seller claims proceeds after auction
- `getPrice()`: Get current token price

### Administrative Functions
- `stop()`: Manually stop the auction (if enabled)
- `cancelAuction()`: Cancel auction and return tokens to seller
- `requestTokensLeftReveal()`: Request decryption of remaining tokens

## Security Features

- Uses OpenZeppelin's Ownable2Step for secure ownership management
- All sensitive values are encrypted using fhEVM
- Built-in checks for auction timing and token availability
- Zero-knowledge proofs for bid validation

## Requirements

- Solidity ^0.8.24
- fhEVM compatible environment
- OpenZeppelin Contracts
- Zama fhEVM contracts

## Usage

1. Deploy the contract with desired parameters:
   - Starting price
   - Discount rate
   - Token addresses (auction token and payment token)
   - Amount of tokens
   - Reserve price
   - Stoppable flag

2. Initialize the auction by calling `initialize()`

3. Users can participate by calling `bid()` with encrypted values

4. After auction ends:
   - Users call `claimUser()` to receive tokens and refunds
   - Seller calls `claimSeller()` to receive proceeds

## License

MIT