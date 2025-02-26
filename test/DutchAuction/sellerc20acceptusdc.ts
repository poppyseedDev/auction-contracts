import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import type { DutchAuctionSellingTokenWithToken, MockERC20 } from "../../types";

describe("DutchAuctionSellingTokenWithToken", function () {
  let auction: DutchAuctionSellingTokenWithToken,
    usdToken: MockERC20,
    auctionToken: MockERC20,
    seller: SignerWithAddress,
    buyer: SignerWithAddress;

  const startingPrice = ethers.parseEther("0.0001");
  const reservePrice = ethers.parseEther("0.00001");
  const discountRate = ethers.parseUnits("10", "wei");
  const tokenUSDAmount = 99999999999970n;
  const tokenAmount = 30000000000000n;

  beforeEach(async function () {
    [seller, buyer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    usdToken = await Token.deploy("Mock Purchase Token", "MPT", seller.address, tokenAmount);
    auctionToken = await Token.deploy("Mock Auctioned Token", "MAT", seller.address, tokenAmount);
    await usdToken.waitForDeployment();
    await auctionToken.waitForDeployment();

    // Mint tokens to seller and buyer
    await auctionToken.connect(seller).mint(seller.address, tokenAmount);
    await usdToken.connect(seller).mint(buyer.address, tokenUSDAmount);

    const DutchAuction = await ethers.getContractFactory("DutchAuctionSellingTokenWithToken");
    auction = await DutchAuction.deploy(
      startingPrice,
      discountRate,
      await auctionToken.getAddress(),
      await usdToken.getAddress(),
      tokenAmount,
      reservePrice,
    );
    await auction.waitForDeployment();
  });

  it("should deploy correctly", async function () {
    expect(await auction.token()).to.equal(await auctionToken.getAddress());
    expect(await auction.paymentToken()).to.equal(await usdToken.getAddress());
    expect(await auction.amount()).to.equal(tokenAmount);
    expect(await auction.startingPrice()).to.equal(startingPrice);
  });

  it("should return the correct price over time", async function () {
    const price1 = await auction.getPrice();
    expect(price1).to.equal(startingPrice);

    await ethers.provider.send("evm_increaseTime", [3600]); // Advance 1 hour
    await ethers.provider.send("evm_mine");
    const price2 = await auction.getPrice();
    expect(price2).to.be.lt(startingPrice);
  });

  it("should allow a buyer to purchase the tokens", async function () {
    // Approve tokens for seller and buyer
    await auctionToken.connect(seller).approve(await auction.getAddress(), tokenAmount);
    await usdToken.connect(buyer).approve(await auction.getAddress(), tokenUSDAmount);

    // Get initial balances
    const buyerInitialUSDBalance = await usdToken.balanceOf(buyer.address);
    const buyerInitialTokenBalance = await auctionToken.balanceOf(buyer.address);
    const sellerInitialUSDBalance = await usdToken.balanceOf(seller.address);
    const sellerInitialTokenBalance = await auctionToken.balanceOf(seller.address);

    console.log("Buyer Initial USD Balance:", ethers.formatEther(buyerInitialUSDBalance));
    console.log("Buyer Initial Token Balance:", ethers.formatEther(buyerInitialTokenBalance));
    console.log("Seller Initial USD Balance:", ethers.formatEther(sellerInitialUSDBalance));
    console.log("Seller Initial Token Balance:", ethers.formatEther(sellerInitialTokenBalance));

    const price = await auction.getPrice();
    const purchaseAmount = 1n; // Buy 1 token for testing
    const totalPrice = price * purchaseAmount;

    console.log("Current Price:", ethers.formatEther(price));
    console.log("Total Price for Purchase:", ethers.formatEther(totalPrice));

    await auction.connect(buyer).buy(purchaseAmount);

    // Check final balances
    const buyerFinalUSDBalance = await usdToken.balanceOf(buyer.address);
    const buyerFinalTokenBalance = await auctionToken.balanceOf(buyer.address);
    const sellerFinalUSDBalance = await usdToken.balanceOf(seller.address);
    const sellerFinalTokenBalance = await auctionToken.balanceOf(seller.address);

    console.log("Buyer Final USD Balance:", ethers.formatEther(buyerFinalUSDBalance));
    console.log("Buyer Final Token Balance:", ethers.formatEther(buyerFinalTokenBalance));
    console.log("Seller Final USD Balance:", ethers.formatEther(sellerFinalUSDBalance));
    console.log("Seller Final Token Balance:", ethers.formatEther(sellerFinalTokenBalance));
    console.log("USD Spent:", ethers.formatEther(buyerInitialUSDBalance - buyerFinalUSDBalance));
    console.log("USD Received by Seller:", ethers.formatEther(sellerFinalUSDBalance - sellerInitialUSDBalance));

    // expect(buyerFinalUSDBalance).to.equal(buyerInitialUSDBalance - totalPrice);
    // expect(buyerFinalTokenBalance).to.equal(buyerInitialTokenBalance + purchaseAmount);
  });

  it("should revert if the auction has ended", async function () {
    await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]); // Advance 7 days
    await ethers.provider.send("evm_mine");

    await expect(auction.connect(buyer).buy(1)).to.be.revertedWith("This auction has ended");
  });
});
