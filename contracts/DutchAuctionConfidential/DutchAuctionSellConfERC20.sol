// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "fhevm/lib/TFHE.sol";
import { ConfidentialERC20 } from "fhevm-contracts/contracts/token/ERC20/ConfidentialERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "fhevm/config/ZamaFHEVMConfig.sol";
import "fhevm/config/ZamaGatewayConfig.sol";
import "fhevm/gateway/GatewayCaller.sol";

contract DutchAuctionSellingConfidentialERC20 is
    SepoliaZamaFHEVMConfig,
    SepoliaZamaGatewayConfig,
    GatewayCaller,
    Ownable2Step
{
    uint private constant DURATION = 7 days;

    ConfidentialERC20 public immutable token;
    ConfidentialERC20 public immutable paymentToken;
    euint64 private tokensLeft;

    address payable public immutable seller;
    uint public immutable startingPrice;
    uint public immutable discountRate;
    uint public immutable startAt;
    uint public immutable expiresAt;
    uint public immutable reservePrice;
    uint public immutable amount;
    bool public auctionStart;

    uint64 public tokensLeftReveal;

    struct Bid {
        euint64 tokenAmount;
        euint64 paidAmount;
    }
    mapping(address => Bid) public bids;

    event EncryptedBidSubmitted(address indexed bidder, einput encryptedBid);
    event TokensSold(address indexed buyer, euint64 encryptedAmount);

    constructor(
        uint _startingPrice,
        uint _discountRate,
        ConfidentialERC20 _token,
        ConfidentialERC20 _paymentToken,
        uint _amount,
        uint _reservePrice
    ) Ownable(msg.sender) {
        seller = payable(msg.sender);
        startingPrice = _startingPrice;
        discountRate = _discountRate;
        startAt = block.timestamp;
        expiresAt = block.timestamp + DURATION;
        reservePrice = _reservePrice;
        auctionStart = false;

        require(_startingPrice >= _discountRate * DURATION + _reservePrice, "Starting price too low");
        require(_reservePrice > 0, "Reserve price must be greater than zero");
        require(_startingPrice > _reservePrice, "Starting price must be greater than reserve price");

        amount = _amount; // initial amount should be known
        tokensLeft = TFHE.asEuint64(_amount);
        token = _token;
        paymentToken = _paymentToken;
        TFHE.allowThis(tokensLeft);
        TFHE.allow(tokensLeft, owner());
    }

    function initialize() external onlyOwner {
        require(!auctionStart, "Auction already started");

        euint64 encAmount = TFHE.asEuint64(amount);

        TFHE.allowTransient(encAmount, address(token));

        // Transfer tokens from seller to the auction contract
        token.transferFrom(msg.sender, address(this), encAmount);
        auctionStart = true;
    }

    function getPrice() public view returns (uint) {
        if (block.timestamp >= expiresAt) {
            return reservePrice;
        }

        uint timeElapsed = block.timestamp - startAt;
        uint discount = discountRate * timeElapsed;
        uint currentPrice = startingPrice > discount ? startingPrice - discount : 0;
        return currentPrice > reservePrice ? currentPrice : reservePrice;
    }

    function bid(einput encryptedValue, bytes calldata inputProof) external {
        require(block.timestamp < expiresAt, "This auction has ended");
        require(auctionStart, "Auction not started");

        euint64 tokenAmount = TFHE.asEuint64(encryptedValue, inputProof); // amount of tokens you want to get

        uint pricePerToken = getPrice();
        euint64 currentPrice = TFHE.asEuint64(pricePerToken);
        euint64 totalCost = TFHE.mul(currentPrice, tokenAmount);

        // Calculate potential refund from previous bid
        Bid storage userBid = bids[msg.sender];
        if (TFHE.isInitialized(userBid.tokenAmount)) {
            euint64 previousTokenAmount = userBid.tokenAmount;
            euint64 previousPaidAmount = userBid.paidAmount;
            euint64 newPriceForOldTokens = TFHE.mul(currentPrice, previousTokenAmount);
            euint64 potentialRefund = TFHE.sub(previousPaidAmount, newPriceForOldTokens);

            // Update total cost by subtracting the potential refund
            totalCost = TFHE.sub(totalCost, potentialRefund);

            // Ensure totalCost doesn't go negative
            ebool isPositiveCost = TFHE.gt(totalCost, TFHE.asEuint64(0));
            totalCost = TFHE.select(isPositiveCost, totalCost, TFHE.asEuint64(0));

            tokenAmount = TFHE.add(previousTokenAmount, tokenAmount);
            totalCost = TFHE.add(previousPaidAmount, totalCost);
        }
        // Check if enough tokens are left
        ebool enoughTokens = TFHE.le(tokenAmount, tokensLeft);
        tokenAmount = TFHE.select(enoughTokens, tokenAmount, TFHE.asEuint64(0));
        totalCost = TFHE.select(enoughTokens, totalCost, TFHE.asEuint64(0));

        // Transfer payment
        TFHE.allowTransient(totalCost, address(paymentToken));
        paymentToken.transferFrom(msg.sender, address(this), totalCost);

        // Update bid information with cumulative amounts
        bids[msg.sender].tokenAmount = tokenAmount;
        bids[msg.sender].paidAmount = totalCost;
        TFHE.allowThis(bids[msg.sender].tokenAmount);
        TFHE.allowThis(bids[msg.sender].paidAmount);

        // Deduct tokens from the remaining balance
        tokensLeft = TFHE.sub(tokensLeft, tokenAmount);
        TFHE.allowThis(tokensLeft);
        TFHE.allow(tokensLeft, owner());

        emit TokensSold(msg.sender, tokenAmount);
    }

    function claimUser() external {
        require(block.timestamp > expiresAt, "Auction hasn't ended");

        Bid storage userBid = bids[msg.sender];

        uint finalPrice = getPrice();
        euint64 finalPricePerToken = TFHE.asEuint64(finalPrice);
        euint64 finalCost = TFHE.mul(finalPricePerToken, userBid.tokenAmount);
        euint64 refundAmount = TFHE.sub(userBid.paidAmount, finalCost);

        // Transfer tokens and refund
        TFHE.allowTransient(userBid.tokenAmount, address(token));
        token.transfer(msg.sender, userBid.tokenAmount);
        TFHE.allowTransient(refundAmount, address(paymentToken));
        paymentToken.transfer(msg.sender, refundAmount);

        // Clear the bid
        delete bids[msg.sender];
    }

    /// @notice Request decryption tokensLeft
    function requestTokensLeftReveal() public onlyOwner {
        uint256[] memory cts = new uint256[](1);
        cts[0] = Gateway.toUint256(tokensLeft);
        Gateway.requestDecryption(cts, this.callbackUint64.selector, 0, block.timestamp + 100, false);
    }

    /// @notice Callback function for 64-bit unsigned integer decryption
    /// @param decryptedInput The decrypted 64-bit unsigned integer
    /// @return The decrypted value
    function callbackUint64(uint256, uint64 decryptedInput) public onlyGateway returns (uint64) {
        tokensLeftReveal = decryptedInput;
        return decryptedInput;
    }

    function cancelAuction() external onlyOwner {
        require(block.timestamp < expiresAt, "Auction already ended");
        TFHE.allowTransient(tokensLeft, address(token));

        // Refund remaining tokens
        token.transfer(seller, tokensLeft);
    }

    function getRemainingTokensEncrypted() external view returns (euint64) {
        return tokensLeft;
    }
}
