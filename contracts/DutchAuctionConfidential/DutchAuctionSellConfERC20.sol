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

    uint64 public tokensLeftReveal;

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

        require(_startingPrice >= _discountRate * DURATION + _reservePrice, "Starting price too low");
        require(_amount > 0, "Token amount must be greater than zero");
        require(_reservePrice > 0, "Reserve price must be greater than zero");
        require(_startingPrice > _reservePrice, "Starting price must be greater than reserve price");

        token = _token;
        paymentToken = _paymentToken;
        amount = _amount; // initial amount should be known
        tokensLeft = TFHE.asEuint64(_amount);
        TFHE.allowThis(tokensLeft);
    }

    function getPrice() public view returns (uint) {
        uint timeElapsed = block.timestamp - startAt;
        uint discount = discountRate * timeElapsed;
        return startingPrice > discount + reservePrice ? startingPrice - discount : reservePrice;
    }

    function buy(einput encryptedValue, bytes calldata inputProof) external {
        require(block.timestamp < expiresAt, "This auction has ended");

        euint64 tokenAmount = TFHE.asEuint64(encryptedValue, inputProof); // amount of tokens you want to get

        uint pricePerToken = getPrice();
        euint64 currentPrice = TFHE.asEuint64(pricePerToken);
        euint64 totalCost = TFHE.mul(currentPrice, tokenAmount);

        // Check if enough tokens are left
        ebool enoughTokens = TFHE.le(tokenAmount, tokensLeft);
        tokenAmount = TFHE.select(enoughTokens, tokenAmount, TFHE.asEuint64(0));
        totalCost = TFHE.select(enoughTokens, totalCost, TFHE.asEuint64(0));

        // Interactions
        paymentToken.transferFrom(msg.sender, seller, totalCost); // Payment with Confidential USDC
        token.transfer(msg.sender, tokenAmount); // Confidential Transfer auctioned tokens

        // Deduct tokens from the remaining balance
        tokensLeft = TFHE.sub(tokensLeft, tokenAmount);
        TFHE.allowThis(tokensLeft);
        TFHE.allow(tokensLeft, owner());

        emit TokensSold(msg.sender, tokenAmount);
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
        require(msg.sender == seller, "Only seller can cancel");
        require(block.timestamp < expiresAt, "Auction already ended");

        // Refund remaining tokens
        token.transfer(seller, tokensLeft);
    }

    function getRemainingTokensEncrypted() external view returns (euint64) {
        return tokensLeft;
    }
}
